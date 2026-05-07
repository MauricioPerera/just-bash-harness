#!/usr/bin/env node
// Entry point. Wires the layers from src/* into a single-binary CLI.
//
// v0.1.3 surface:
//   harness new [--policy <path>]
//   harness chat <sessionId> [--message <txt> | --interactive | -i] [--model <id>]
//   harness skills list
//   harness skills add <pack@version>
//   harness resume <sessionId>
//   harness sessions
//   harness audit <sessionId> [--limit N]
//   harness version

import { join } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  FileBank,
  defaultBankRoot,
  resolveEmbedderFromEnv,
  createStubEmbedder,
  runSync,
  runBench,
  type EmbeddingProvider,
} from "@rckflr/agent-skills-cli";

import { createToolbox } from "./toolbox.js";
import { createSessionStore } from "./session.js";
import { createApprovalGate, promptUserApproval } from "./approval.js";
import {
  createApprovalStatsStore,
  suggestOverrides,
  renderSuggestionsYaml,
  renderSkippedSection,
  type ApprovalStatsStore,
} from "./approval-stats.js";
import { runRekey, cleanupBackups, parseDuration, type RekeyTarget } from "./rekey.js";
import { detectEncryptionError, wrapEncryptionError } from "./util-encryption-error.js";
import { resolveProviderFromEnv } from "./provider.js";
import { loadPolicy, DEFAULT_POLICY } from "./policy.js";
import { runTurn } from "./loop.js";
import { createMemoryStore, type Memory } from "./memory.js";
import { parseArgs, type Args } from "./cli-args.js";
import type { Policy, SessionId } from "./types.js";
// Pull harness version from package.json so we have a single source of truth.
// tsup inlines the import at build time; tsc validates against the JSON
// schema. v0.2.5 -> v0.2.6 had the version stale in source vs package.json
// because the constant was duplicated; this prevents that recurrence.
import packageJson from "../package.json" with { type: "json" };

const HARNESS_VERSION = packageJson.version;

const HELP = `harness — agentic harness on just-bash (v${HARNESS_VERSION})

Usage:
  harness new [--policy <path>]
  harness do "<task>" [--policy <path>] [--model <id>] [--allow-unsigned] [--quiet]
  harness chat <sessionId> [--message <txt> | --interactive | -i] [--model <id>] [--allow-unsigned]
  harness resume <sessionId>
  harness sessions
  harness audit <sessionId> [--limit N]
  harness audit --suggest-overrides [--min-asks N] [--min-ratio R] [--quiet]
  harness skills list [--all]
  harness skills add <pack@version>
  harness search <query> [--topK N] [--budget N] [--kind <k>] [--session <id>]
  harness recall <query>              (alias for search)
  harness memory list [--kind <k>] [--limit N]
  harness memory forget <id>          (or --kind <k> | --session <id>)
  harness memory remember <content> [--kind <k>] [--session <id>]
  harness memory stats
  harness memory export <path>
  harness bench --truth <path> [--threshold N] [--rerank <mode>] [--k N]
  harness rekey --from-env <var> --to-env <var> [--target sessions|memory|skills|all] [--dry-run]
  harness rekey --cleanup-backups [--older-than <duration>] [--yes]
  harness version

LLM provider (auto-detected; HARNESS_PROVIDER overrides):
  CF_ACCOUNT_ID + CF_API_TOKEN   → cloudflare (Workers AI, default model
                                   @cf/google/gemma-4-26b-a4b-it)
  ANTHROPIC_API_KEY              → anthropic (default model claude-opus-4-7)

Embedding provider (skill retrieval; CLI auto-detects):
  CF_ACCOUNT_ID + CF_API_TOKEN   → cloudflare embeddings
  OPENAI_API_KEY                 → OpenAI embeddings
  OLLAMA_MODEL (+ OLLAMA_BASE_URL) → Ollama
  TRANSFORMERS_MODEL             → transformers.js (in-process)
  (none)                         → stub embedder (testing only)

Other env vars:
  HARNESS_PROVIDER          force provider: anthropic | cloudflare
  HARNESS_POLICY            default policy path; --policy overrides
  HARNESS_DEFAULT_MODEL     override default model name
  CF_LLM_MODEL              override Cloudflare LLM model
  HARNESS_ENCRYPTION_KEY    AES-256-GCM key for sessions + memory at rest
                            (required when policy.encryption.enabled: true)

Examples:
  # One-shot ops invocation — ephemeral session, single turn, audit kept
  harness do "what is my disk usage?"
  harness do "list files modified in /tmp in the last hour" --quiet

  # Bootstrap with default policy and one turn
  SID=$(harness new)
  echo "what is 2+2?" | harness chat "$SID"
  harness audit "$SID"

  # Subscribe a skill pack and use it
  harness skills add github.com/foo/bar@v1.0.0
  echo "use the foo skill" | harness chat "$SID"

  # Force Anthropic, override model
  HARNESS_PROVIDER=anthropic harness chat "$SID" \\
    --message "hi" --model claude-sonnet-4-6

  # List recent sessions, dive into one
  harness sessions
  harness resume <id>

  # Local development: drop the signed-skill requirement (use only when
  # iterating on unsigned local packs; the deny error message also points
  # at this flag whenever the signature gate fires).
  harness chat "$SID" --allow-unsigned --message "test the local skill"
`;

// ─── shared deps ────────────────────────────────────────────────────────────

const resolvePolicyPath = (flags: Map<string, string | true>): string | undefined => {
  const v = flags.get("policy");
  if (typeof v === "string") return v;
  return process.env["HARNESS_POLICY"] ?? undefined;
};

const loadPolicyOrDefault = async (path: string | undefined): Promise<Policy> => {
  if (!path) return DEFAULT_POLICY;
  try {
    return await loadPolicy(path);
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? `policy file not found: ${path}`
      : `failed to load policy ${path}: ${(err as Error).message}`;
    throw new Error(msg);
  }
};

// Imported lazily here so test-only modules don't pull cli.ts via barrel.
import { applyPolicyOverrides as applyPolicyOverridesPure } from "./policy-overrides.js";

const applyPolicyOverrides = (policy: Policy, flags: Map<string, string | true>): Policy =>
  applyPolicyOverridesPure(policy, flags, {
    warn: (line) => process.stderr.write(line),
  });

const resolveEmbedderOrStub = (): EmbeddingProvider => {
  try {
    return resolveEmbedderFromEnv();
  } catch {
    process.stderr.write(
      "  (no embedder configured — using stub. Set OLLAMA_MODEL / OPENAI_API_KEY / CF_* for real retrieval.)\n",
    );
    return createStubEmbedder();
  }
};

const ensureBank = async (
  policy: Policy,
  embedder: EmbeddingProvider,
): Promise<FileBank> => {
  const rootDir = policy.paths.skillsBankDir ?? defaultBankRoot();
  await mkdir(rootDir, { recursive: true });
  const bank = new FileBank({ rootDir });
  const meta = await bank.getMeta();
  if (meta === null) {
    await bank.initMeta({
      embedding_model: embedder.name,
      embedding_dim: embedder.dim,
    });
  }
  return bank;
};

const ensureSessionsRoot = async (policy: Policy): Promise<string> => {
  const dir = policy.paths.sessionsRoot;
  await mkdir(dir, { recursive: true });
  return dir;
};

/** Construct the bank-level approval stats store. Same encryption settings
 *  as session storage. The skills bank dir already exists by the time this
 *  is called (ensureBank() ran first), so no mkdir needed here. */
const buildApprovalStatsStore = (policy: Policy): ApprovalStatsStore => {
  const bankRoot = policy.paths.skillsBankDir ?? defaultBankRoot();
  const enc = policy.encryption.enabled
    ? {
        encryptionKey: process.env["HARNESS_ENCRYPTION_KEY"] ?? "",
        ...(policy.encryption.saltSession !== undefined
          ? { encryptionSalt: policy.encryption.saltSession }
          : {}),
      }
    : {};
  return createApprovalStatsStore({
    bankRoot,
    ...enc,
    onError: (err) => {
      // Non-fatal; surface to stderr so the operator knows but the
      // approval flow continues.
      process.stderr.write(`  (approval-stats: ${err.message})\n`);
    },
  });
};

/** Construct a SessionStore from policy, forwarding encryption when enabled.
 *  The four cli subcommands that use sessions all share this code path. */
const buildSessionStore = (policy: Policy): ReturnType<typeof createSessionStore> => {
  const key = resolveEncryptionKey(policy);
  return createSessionStore({
    sessionsRoot: policy.paths.sessionsRoot,
    loadPolicy: () => Promise.resolve(policy),
    ...(key !== undefined ? { encryptionKey: key } : {}),
    ...(policy.encryption.saltSession !== undefined
      ? { encryptionSalt: policy.encryption.saltSession }
      : {}),
  });
};

/** Resolve the encryption key from env when policy.encryption.enabled.
 *  Throws if enabled and the env var is missing. Returns undefined when
 *  encryption is off. */
const resolveEncryptionKey = (policy: Policy): string | undefined => {
  if (!policy.encryption.enabled) return undefined;
  const key = process.env["HARNESS_ENCRYPTION_KEY"];
  if (typeof key !== "string" || key.length === 0) {
    throw new Error(
      "policy.encryption.enabled = true but HARNESS_ENCRYPTION_KEY env var is not set. " +
      "Set it before invoking the harness, or set policy.encryption.enabled = false.",
    );
  }
  return key;
};

/** Construct a Memory dep when policy.memory.enabled. Re-uses the embedder
 *  the harness picked for retrieval so memory + skill recall vectors stay
 *  in the same model space. Forwards encryption key+salt when enabled. */
const buildMemoryIfEnabled = async (
  policy: Policy,
  embedder: EmbeddingProvider,
): Promise<Memory | undefined> => {
  if (!policy.memory.enabled) return undefined;
  await mkdir(policy.memory.rootDir, { recursive: true });
  const key = resolveEncryptionKey(policy);
  return createMemoryStore({
    rootDir: policy.memory.rootDir,
    embedder,
    ...(key !== undefined ? { encryptionKey: key } : {}),
    ...(policy.encryption.saltMemory !== undefined
      ? { encryptionSalt: policy.encryption.saltMemory }
      : {}),
  });
};

/** Wrap a subcommand so that domain errors print as `harness <cmd>: <msg>`
 *  rather than reaching main's generic `fatal:` handler. Returns exit code 1
 *  on caught exception. */
const withCommandError = async (
  cmd: string,
  args: Args,
  fn: () => Promise<number>,
): Promise<number> => {
  try {
    return await fn();
  } catch (err) {
    // Detect AES-GCM key-mismatch and wrap with HARNESS_ENCRYPTION_KEY hint.
    // Belt-and-suspenders: heuristic is already tight (see util-encryption-error.ts),
    // but we additionally gate on policy.encryption.enabled so users on
    // unencrypted banks who hit a coincidental decrypt-shaped error don't
    // see a key-rotation hint that doesn't apply to them. Policy load
    // failures fall through to the unwrapped path — bias toward false
    // negatives per the contract.
    if (detectEncryptionError(err)) {
      try {
        const policyPath = resolvePolicyPath(args.flags);
        const policy = await loadPolicyOrDefault(policyPath);
        if (policy.encryption?.enabled === true) {
          const wrapped = wrapEncryptionError(err, `harness ${cmd}`);
          process.stderr.write(`${wrapped.message}\n`);
          return 1;
        }
      } catch {
        // Policy load failed; fall through to default error path.
      }
    }
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`harness ${cmd}: ${msg}\n`);
    return 1;
  }
};

// ─── subcommands ────────────────────────────────────────────────────────────

const cmdVersion = (): number => {
  process.stdout.write(`harness ${HARNESS_VERSION}\n`);
  return 0;
};

const cmdNew = async (args: Args): Promise<number> => {
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);

  const sessionsRoot = await ensureSessionsRoot(policy);
  const sessionStore = buildSessionStore(policy);

  const id = await sessionStore.create({
    policyPath: policyPath ?? "<default>",
    sessionRoot: sessionsRoot,
  });

  process.stdout.write(`${id}\n`);
  process.stderr.write(`session created at ${join(sessionsRoot, id)}\n`);
  return 0;
};

/** Build the oneshot session ID. Format: `oneshot/onesht_<unix-ts>_<short>`.
 *  The leading `oneshot/` literal is the audit-trail breadcrumb that lets
 *  `harness sessions` and `harness audit` recognize ephemeral sessions
 *  without ambiguity. The bare ID after the slash uses an `onesht_`
 *  prefix (intentionally not `s_`) so a future migration that drops the
 *  subdir layout can still distinguish IDs by prefix alone. */
const newOneshotSessionId = (): SessionId => {
  // randomUUID is ESM-imported transitively via session.ts but cli.ts
  // doesn't import it directly. Pull from node:crypto here.
  const ts = Math.floor(Date.now() / 1000);
  // 6 hex chars = 16M space; collision risk over the lifetime of one
  // user's history is negligible.
  const short = randomUUID().replace(/-/g, "").slice(0, 6);
  return `oneshot/onesht_${ts}_${short}` as SessionId;
};

const cmdDo = async (args: Args): Promise<number> => {
  const task = args.positional[0];
  if (!task || typeof task !== "string" || task.trim().length === 0) {
    process.stderr.write(
      "harness do: <task> required. Example: harness do \"what is my disk usage?\"\n",
    );
    return 64;
  }

  // Mirrors cmdChat's one-shot path. Kept as a separate function rather
  // than refactoring through cmdChat because the ephemeral-session
  // semantics (auto-create + no resume + oneshot subdir) are clearer
  // expressed standalone than as a third mode flag inside cmdChat.
  const policyPath = resolvePolicyPath(args.flags);
  const policy = applyPolicyOverrides(
    await loadPolicyOrDefault(policyPath),
    args.flags,
  );
  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);
  await ensureSessionsRoot(policy);
  const sessionStore = buildSessionStore(policy);
  const toolbox = createToolbox({ bank, embedder });
  const approvalStats = buildApprovalStatsStore(policy);
  const approval = createApprovalGate({
    policy,
    audit: async (record) => {
      const askedUser = record.source === "user";
      await approvalStats.record(record.action.skillId, record.decision, askedUser);
    },
  });
  const memory = await buildMemoryIfEnabled(policy, embedder);

  const modelOverride = args.flags.get("model");
  let provider: ReturnType<typeof resolveProviderFromEnv>;
  try {
    provider = resolveProviderFromEnv({
      ...(typeof modelOverride === "string" ? { model: modelOverride } : {}),
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 78;
  }

  const sessionId = newOneshotSessionId();
  await sessionStore.create({
    policyPath: policyPath ?? "<default>",
    sessionRoot: policy.paths.sessionsRoot,
    customId: sessionId,
  });

  const quiet = args.flags.get("quiet") === true;
  if (!quiet) {
    process.stderr.write(`[provider: ${provider.choice} / ${provider.model}]\n`);
    process.stderr.write(`[oneshot session: ${sessionId}]\n`);
    if (memory) {
      process.stderr.write(`[memory: enabled at ${policy.memory.rootDir}]\n`);
    }
  }

  // SIGINT handling — first press cancels, second hard-exits. Same shape
  // as cmdChat so the operator's mental model is identical.
  const controller = new AbortController();
  let interruptCount = 0;
  const onSigint = (): void => {
    interruptCount++;
    if (interruptCount === 1) {
      process.stderr.write(
        "\n[SIGINT — finishing current provider event then stopping; press Ctrl+C again to force]\n",
      );
      controller.abort();
    } else {
      process.stderr.write("\n[double SIGINT — hard exit]\n");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  try {
    const turn = await runTurn(
      {
        provider: provider.provider,
        toolbox,
        approval,
        session: sessionStore,
        policy,
        ...(memory ? { memory } : {}),
      },
      {
        sessionId,
        userMessage: task,
        signal: controller.signal,
        handlers: {
          // --quiet suppresses streaming text/thinking/tool-call events
          // but keeps approval prompts and the final result. Errors and
          // final status still go to stderr unconditionally.
          ...(quiet
            ? {}
            : {
                onText: (delta: string) => process.stdout.write(delta),
                onThinking: (delta: string) => process.stderr.write(delta),
                onToolCall: (id: string, skillId: string) => {
                  process.stderr.write(`\n[tool_call ${id} → ${skillId}]\n`);
                },
              }),
          onApprovalAsk: promptUserApproval,
        },
      },
    );

    const stop = turn.output.stopReason;
    const toolCalls = turn.output.toolCalls.length;

    // In quiet mode the assistant text wasn't streamed; print the final
    // text now so scripted callers get a single output blob.
    if (quiet) {
      const finalText = turn.output.text ?? "";
      if (finalText.length > 0) {
        process.stdout.write(finalText);
        if (!finalText.endsWith("\n")) process.stdout.write("\n");
      }
    } else {
      process.stdout.write(`\n[stop: ${stop}]\n`);
      if (toolCalls > 0) {
        process.stderr.write(
          `[turn ${turn.id} ran ${toolCalls} tool call(s)]\n`,
        );
      }
    }

    return stop === "error" ? 1 : stop === "cancelled" ? 130 : 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
};

const REPL_HELP = `
Slash commands:
  /help                show this help
  /audit [--limit N]   show recent approvals + bank audit for this session
  /recall <query>      semantic search over memory (requires policy.memory.enabled)
  /memory list         shallow list of all memories
  /memory stats        memory store stats
  /clear               clear screen
  /exit                end the REPL (Ctrl+D also works)

Anything else is sent as a user message to the LLM.
`;

const cmdChat = async (args: Args): Promise<number> => {
  const sessionId = args.positional[0] as SessionId | undefined;
  if (!sessionId) {
    process.stderr.write("harness chat: <sessionId> required\n");
    return 64;
  }

  // Mode detection:
  //  - --message <txt>            → one-shot, send that message and exit
  //  - --interactive / -i         → force REPL even if stdin is non-TTY
  //  - stdin is TTY & no --message → REPL by default
  //  - stdin is non-TTY & no --message → read all stdin as one message
  const messageFlag = args.flags.get("message");
  const interactiveFlag =
    args.flags.get("interactive") === true || args.flags.get("i") === true;

  let oneShotMessage: string | undefined;
  let repl = false;

  if (typeof messageFlag === "string") {
    oneShotMessage = messageFlag;
  } else if (interactiveFlag) {
    repl = true;
  } else if (process.stdin.isTTY) {
    repl = true;
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const piped = Buffer.concat(chunks).toString("utf8").trim();
    if (!piped) {
      process.stderr.write("empty stdin\n");
      return 64;
    }
    oneShotMessage = piped;
  }

  // ── Build deps once. Both modes share these. ───────────────────────────
  const policyPath = resolvePolicyPath(args.flags);
  const policy = applyPolicyOverrides(
    await loadPolicyOrDefault(policyPath),
    args.flags,
  );
  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);
  await ensureSessionsRoot(policy);
  const sessionStore = buildSessionStore(policy);
  const toolbox = createToolbox({ bank, embedder });
  const approvalStats = buildApprovalStatsStore(policy);
  const approval = createApprovalGate({
    policy,
    // Best-effort: increment the bank-level stats. Failures swallowed
    // (logged via the store's onError) — never break the approval flow.
    audit: async (record) => {
      const askedUser = record.source === "user";
      await approvalStats.record(record.action.skillId, record.decision, askedUser);
    },
  });
  const memory = await buildMemoryIfEnabled(policy, embedder);

  const modelOverride = args.flags.get("model");

  // Lazy provider resolution: REPL mode without creds opens fine and only
  // fails when the user actually sends a message. Slash commands like
  // /memory and /audit don't need an LLM and shouldn't be blocked.
  let providerCache: {
    provider: ReturnType<typeof resolveProviderFromEnv>["provider"];
    choice: ReturnType<typeof resolveProviderFromEnv>["choice"];
    model: string;
  } | null = null;
  let providerError: string | null = null;
  const ensureProvider = (): typeof providerCache => {
    if (providerCache !== null) return providerCache;
    if (providerError !== null) throw new Error(providerError);
    try {
      const resolved = resolveProviderFromEnv({
        ...(typeof modelOverride === "string" ? { model: modelOverride } : {}),
      });
      providerCache = {
        provider: resolved.provider,
        choice: resolved.choice,
        model: resolved.model,
      };
      return providerCache;
    } catch (err) {
      providerError = (err as Error).message;
      throw err;
    }
  };

  // For one-shot mode we must resolve up-front. For REPL we defer.
  if (oneShotMessage !== undefined) {
    try {
      const p = ensureProvider();
      if (p) {
        process.stderr.write(`[provider: ${p.choice} / ${p.model}]\n`);
      }
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 78;
    }
  } else {
    // REPL mode — show provider state at startup but don't fail.
    try {
      const p = ensureProvider();
      if (p) process.stderr.write(`[provider: ${p.choice} / ${p.model}]\n`);
    } catch {
      process.stderr.write(
        `[provider: NOT configured — slash commands work, sending messages will fail]\n`,
      );
    }
  }
  if (memory) {
    process.stderr.write(`[memory: enabled at ${policy.memory.rootDir}]\n`);
  }

  // ── One turn through the loop. Used by both one-shot and REPL paths. ──
  const runOneTurn = async (
    userMessage: string,
    signal: AbortSignal,
  ): Promise<{ stop: string; toolCalls: number; turnId: string }> => {
    const p = ensureProvider();
    if (!p) throw new Error("provider not initialized");
    const turn = await runTurn(
      {
        provider: p.provider,
        toolbox,
        approval,
        session: sessionStore,
        policy,
        ...(memory ? { memory } : {}),
      },
      {
        sessionId,
        userMessage,
        signal,
        handlers: {
          onText: (delta) => process.stdout.write(delta),
          onThinking: (delta) => process.stderr.write(delta),
          onToolCall: (id, skillId) => {
            process.stderr.write(`\n[tool_call ${id} → ${skillId}]\n`);
          },
          onApprovalAsk: promptUserApproval,
        },
      },
    );
    return {
      stop: turn.output.stopReason,
      toolCalls: turn.output.toolCalls.length,
      turnId: turn.id,
    };
  };

  // SIGINT handling: same semantics for both modes — first press cancels
  // the current turn, second press hard-exits.
  let activeController: AbortController | null = null;
  let interruptCount = 0;
  const onSigint = (): void => {
    interruptCount++;
    if (interruptCount === 1) {
      process.stderr.write(
        "\n[SIGINT — finishing current provider event then stopping; press Ctrl+C again to force]\n",
      );
      activeController?.abort();
    } else {
      process.stderr.write("\n[double SIGINT — hard exit]\n");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  try {
    // ── ONE-SHOT MODE ────────────────────────────────────────────────────
    if (oneShotMessage !== undefined) {
      activeController = new AbortController();
      const result = await runOneTurn(oneShotMessage, activeController.signal);
      process.stdout.write(`\n[stop: ${result.stop}]\n`);
      if (result.toolCalls > 0) {
        process.stderr.write(
          `[turn ${result.turnId} ran ${result.toolCalls} tool call(s)]\n`,
        );
      }
      return result.stop === "error" ? 1 : result.stop === "cancelled" ? 130 : 0;
    }

    // ── REPL MODE ────────────────────────────────────────────────────────
    process.stderr.write(
      `[REPL — session ${sessionId}. Type /help for commands, /exit or Ctrl+D to leave]\n`,
    );

    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });

    let lastExit = 0;
    while (true) {
      let line: string;
      try {
        line = await rl.question(`\nharness:${sessionId.slice(-6)}> `);
      } catch {
        // Ctrl+D / stream closed.
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      // Reset SIGINT counter for each new prompt.
      interruptCount = 0;

      // ── Slash commands ──────────────────────────────────────────────
      if (trimmed.startsWith("/")) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        // Inherit --policy from the parent invocation so memory/audit
        // subcommands see the same policy the REPL was opened with.
        const inheritedFlags = new Map<string, string | true>();
        const parentPolicy = args.flags.get("policy");
        if (typeof parentPolicy === "string") {
          inheritedFlags.set("policy", parentPolicy);
        }
        switch (cmd) {
          case "exit":
          case "quit":
            rl.close();
            return lastExit;
          case "help":
            process.stdout.write(REPL_HELP);
            break;
          case "clear":
            process.stdout.write("\x1b[2J\x1b[H");
            break;
          case "audit": {
            const subFlags = new Map(inheritedFlags);
            // Re-parse rest for --limit
            for (let i = 0; i < rest.length; i++) {
              const r = rest[i] ?? "";
              if (r.startsWith("--")) {
                const eq = r.indexOf("=");
                if (eq > 0) subFlags.set(r.slice(2, eq), r.slice(eq + 1));
                else if (rest[i + 1] !== undefined && !(rest[i + 1] ?? "").startsWith("--")) {
                  subFlags.set(r.slice(2), rest[i + 1] ?? "");
                  i++;
                } else subFlags.set(r.slice(2), true);
              }
            }
            await cmdAudit({ positional: [sessionId], flags: subFlags });
            break;
          }
          case "recall":
          case "search": {
            const query = rest.join(" ");
            if (!query) {
              process.stderr.write("usage: /recall <query>\n");
              break;
            }
            await cmdRecall(
              { positional: query.split(/\s+/), flags: inheritedFlags },
              "recall",
            );
            break;
          }
          case "memory": {
            const sub = rest[0];
            const subArgs: Args = {
              positional: [sub ?? "", ...rest.slice(1)],
              flags: inheritedFlags,
            };
            if (sub === "list") await cmdMemoryList(subArgs);
            else if (sub === "stats") await cmdMemoryStats(subArgs);
            else process.stderr.write("usage: /memory <list|stats>\n");
            break;
          }
          default:
            process.stderr.write(`unknown command: /${cmd}. Try /help\n`);
        }
        continue;
      }

      // ── Regular user message ────────────────────────────────────────
      activeController = new AbortController();
      try {
        const result = await runOneTurn(trimmed, activeController.signal);
        process.stdout.write(`\n[stop: ${result.stop}`);
        if (result.toolCalls > 0) {
          process.stdout.write(`, ${result.toolCalls} tool call(s)`);
        }
        process.stdout.write(`]\n`);
        lastExit =
          result.stop === "error" ? 1 : result.stop === "cancelled" ? 130 : 0;
      } catch (err) {
        process.stderr.write(`turn failed: ${(err as Error).message}\n`);
        lastExit = 1;
      } finally {
        activeController = null;
      }
    }
    rl.close();
    // Issue #14: dispose cached Bash instances on REPL exit so the
    // child-process handles in createBankBash don't outlive the
    // user-facing readline session. For one-shot CLI invocations this
    // is reached via process exit so dispose() would be a no-op; for
    // REPL it actually frees per-session subprocesses.
    sessionStore.dispose();
    return lastExit;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
};

const cmdSkillsList = async (args: Args): Promise<number> => {
  const showAll = args.flags.get("all") === true;
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);

  // Source of truth for "what's subscribed" is the bank.
  const subscribed = await bank.listSkills();
  if (subscribed.length === 0) {
    process.stderr.write(
      "no skills subscribed. Use 'harness skills add <pack@version>'.\n",
    );
    return 0;
  }

  // Apply applicable_when filter unless --all is passed. Cheap host probe;
  // re-uses the same logic the loop will apply at chat time.
  const toolbox = createToolbox({ bank, embedder, filterApplicable: !showAll });
  const visible = await toolbox.list();
  const visibleIds = new Set(visible.map((s) => s.id));

  for (const s of subscribed) {
    const filteredOut = !showAll && !visibleIds.has(s.identity);
    if (filteredOut) continue;
    process.stdout.write(`${s.identity}\n`);
    process.stdout.write(`  title:     ${s.title}\n`);
    process.stdout.write(`  use_when:  ${s.use_when}\n`);
    process.stdout.write(`  signature: ${s.provenance.signature_status ?? "unsigned"}\n`);
    process.stdout.write("\n");
  }

  if (!showAll && visible.length < subscribed.length) {
    process.stderr.write(
      `# ${subscribed.length - visible.length} skill(s) hidden by applicable_when filter — pass --all to see them\n`,
    );
  }
  return 0;
};

const cmdSkillsAdd = async (args: Args): Promise<number> => {
  const spec = args.positional[1]; // 'add' is positional[0]
  if (!spec) {
    process.stderr.write("harness skills add: <pack@version> required\n");
    return 64;
  }
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    process.stderr.write(
      `harness skills add: malformed spec '${spec}' (expected <pack>@<ref>)\n`,
    );
    return 64;
  }
  const pack = spec.slice(0, at);
  const ref = spec.slice(at + 1);

  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);

  // SyncOptions takes a combined `<repo>@<ref>` source spec.
  const result = await runSync({ bank, embedder, source: `${pack}@${ref}` });
  process.stdout.write(
    `synced ${result.synced}/${result.total} skill(s) from ${pack}@${ref} (resolved → ${result.ref_resolved})\n`,
  );
  for (const s of result.skills) {
    const note = s.message ? ` — ${s.message}` : "";
    process.stdout.write(`  ${s.identity ?? s.id}  [${s.status}]${note}\n`);
  }
  return 0;
};

const cmdResume = async (args: Args): Promise<number> => {
  const sessionId = args.positional[0] as SessionId | undefined;
  if (!sessionId) {
    process.stderr.write("harness resume: <sessionId> required\n");
    return 64;
  }
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const sessionsRoot = await ensureSessionsRoot(policy);
  const sessionStore = buildSessionStore(policy);

  const session = await sessionStore.resume(sessionId);
  process.stdout.write(`session ${session.id}\n`);
  process.stdout.write(`  created:  ${session.createdAt}\n`);
  process.stdout.write(`  turns:    ${session.turns.length}\n`);
  if (session.turns.length > 0) {
    const last = session.turns[session.turns.length - 1]!;
    process.stdout.write(
      `  last:     ${last.id} (${last.ts}, stop=${last.output.stopReason})\n`,
    );
  }
  return 0;
};

const cmdAuditSuggestOverrides = async (args: Args): Promise<number> => {
  const minAsksFlag = args.flags.get("min-asks");
  const minAsks = typeof minAsksFlag === "string"
    ? Math.max(1, parseInt(minAsksFlag, 10) || 5)
    : 5;
  const minRatioFlag = args.flags.get("min-ratio");
  const minAllowRatio = typeof minRatioFlag === "string"
    ? Math.max(0, Math.min(1, parseFloat(minRatioFlag) || 0.95))
    : 0.95;

  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  // Ensure the bank exists (creating an empty stats coll on first run is fine).
  const embedder = resolveEmbedderOrStub();
  await ensureBank(policy, embedder);
  const stats = buildApprovalStatsStore(policy);
  const all = await stats.list();

  process.stdout.write(`# approval stats: ${all.length} skill(s) tracked\n`);
  process.stdout.write(`# threshold: min-asks=${minAsks} min-allow-ratio=${minAllowRatio}\n\n`);

  const result = suggestOverrides(all, { minAsks, minAllowRatio });
  process.stdout.write(renderSuggestionsYaml(result.suggestions));
  // --quiet suppresses the destructive-skill skipped section. Default is
  // verbose so users understand WHY frequently-approved destructive skills
  // never appear in the YAML block. See DESIGN §3.3 for the pattern list.
  const quiet = args.flags.get("quiet") === true;
  if (!quiet) {
    process.stdout.write(renderSkippedSection(result.skipped));
  }
  if (result.suggestions.length > 0) {
    process.stderr.write(
      `\n# ${result.suggestions.length} suggestion(s). Paste the block above into your policy YAML.\n`,
    );
  }
  return 0;
};

const cmdSessions = async (args: Args): Promise<number> => {
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const sessionsRoot = await ensureSessionsRoot(policy);

  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("s_"));

  // Oneshot sessions live under <sessionsRoot>/oneshot/onesht_<ts>_<short>.
  // Enumerate that subdir if it exists so users see ephemeral sessions
  // alongside regular ones, but tagged so they're distinguishable.
  type Entry = { id: string; mtime: Date; oneshot: boolean };
  const regulars: Entry[] = await Promise.all(
    dirs.map(async (d) => {
      const path = join(sessionsRoot, d.name);
      const s = await stat(path);
      return { id: d.name, mtime: s.mtime, oneshot: false };
    }),
  );
  let oneshots: Entry[] = [];
  const oneshotRoot = join(sessionsRoot, "oneshot");
  try {
    const oneshotEntries = await readdir(oneshotRoot, { withFileTypes: true });
    const oneshotDirs = oneshotEntries.filter(
      (e) => e.isDirectory() && e.name.startsWith("onesht_"),
    );
    oneshots = await Promise.all(
      oneshotDirs.map(async (d) => {
        const path = join(oneshotRoot, d.name);
        const s = await stat(path);
        // Display the full audit-trail-friendly id (with the oneshot/ prefix)
        // so users can paste it into `harness audit` directly.
        return { id: `oneshot/${d.name}`, mtime: s.mtime, oneshot: true };
      }),
    );
  } catch (err) {
    // ENOENT = no oneshot/ subdir created yet. Silent fallthrough.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const withStats: Entry[] = [...regulars, ...oneshots];
  if (withStats.length === 0) {
    process.stderr.write(`no sessions under ${sessionsRoot}\n`);
    return 0;
  }

  // Sort newest first by mtime.
  withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  process.stderr.write(`# ${withStats.length} session(s) under ${sessionsRoot}\n`);
  for (const e of withStats) {
    const tag = e.oneshot ? " [oneshot]" : "";
    process.stdout.write(`${e.id}  ${e.mtime.toISOString()}${tag}\n`);
  }
  return 0;
};

const cmdAudit = async (args: Args): Promise<number> => {
  // --suggest-overrides operates on bank-level stats, not on a session.
  if (args.flags.get("suggest-overrides") === true) {
    return cmdAuditSuggestOverrides(args);
  }

  const sessionId = args.positional[0] as SessionId | undefined;
  if (!sessionId) {
    process.stderr.write("harness audit: <sessionId> required (or pass --suggest-overrides for bank-wide analysis)\n");
    return 64;
  }

  const limitFlag = args.flags.get("limit");
  const limit = typeof limitFlag === "string" ? Math.max(1, parseInt(limitFlag, 10) || 20) : 20;

  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const sessionsRoot = await ensureSessionsRoot(policy);
  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);
  const sessionStore = buildSessionStore(policy);

  const session = await sessionStore.load(sessionId);

  process.stdout.write(`session ${session.id}\n`);
  process.stdout.write(`  created: ${session.createdAt}\n`);
  process.stdout.write(`  turns:   ${session.turns.length}\n\n`);

  const allApprovals = session.turns.flatMap((t) => t.approvals);
  if (allApprovals.length === 0) {
    process.stdout.write("no approvals recorded yet.\n\n");
  } else {
    const recent = allApprovals.slice(-limit);
    process.stdout.write(
      `approvals (last ${recent.length} of ${allApprovals.length}):\n`,
    );
    for (const a of recent) {
      const skill = a.action.skillId.split("/").at(-1) ?? a.action.skillId;
      const reasons = a.action.derivedFrom.length > 0
        ? `[${a.action.derivedFrom.join(",")}]`
        : "";
      process.stdout.write(
        `  ${a.ts}  ${a.decision.padEnd(5)} ${a.source.padEnd(6)} ${a.action.category.padEnd(10)} ${skill}  ${reasons}\n`,
      );
    }
    process.stdout.write("\n");
  }

  const bankAudit = await bank.listAudit({ limit });
  if (bankAudit.length > 0) {
    process.stdout.write(
      `bank audit (last ${bankAudit.length} skill executions, all sessions):\n`,
    );
    for (const e of bankAudit) {
      const skill = e.skill_id.split("/").at(-1) ?? e.skill_id;
      const intent = e.intent ? ` intent="${e.intent.slice(0, 60)}"` : "";
      process.stdout.write(
        `  ${e.timestamp}  ${skill.padEnd(20)}  exit=${e.exit_code} ${e.elapsed_ms}ms${intent}\n`,
      );
    }
  }

  return 0;
};

// ─── bench ─────────────────────────────────────────────────────────────────

const cmdBench = async (args: Args): Promise<number> => {
  const truthFile = args.flags.get("truth");
  if (typeof truthFile !== "string") {
    process.stderr.write(
      "harness bench: --truth <path> required (JSON or JSONL with {intent, expected} entries)\n",
    );
    return 64;
  }
  const k = Number(args.flags.get("k") ?? "5") || 5;
  const rerankMode = (args.flags.get("rerank") as
    | "global"
    | "intent-conditional"
    | "none"
    | undefined) ?? undefined;
  const thresholdFlag = args.flags.get("threshold");
  // Threshold is interpreted as top-1 accuracy in [0, 1]. Defaults to 0
  // (informational run, exit 0 regardless). Useful values: 0.7, 0.9.
  const threshold = typeof thresholdFlag === "string"
    ? Number(thresholdFlag)
    : 0;

  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);

  const skills = await bank.listSkills();
  if (skills.length === 0) {
    process.stderr.write(
      "harness bench: no skills in bank — subscribe a pack first with 'harness skills add <pack@version>'\n",
    );
    return 64;
  }

  process.stderr.write(
    `[bench: ${skills.length} skills, embedder=${embedder.name}, k=${k}, rerank=${rerankMode ?? "intent-conditional (default)"}]\n`,
  );

  const result = await runBench({
    truthFile,
    bank,
    embedder,
    k,
    ...(rerankMode !== undefined ? { rerankMode } : {}),
  });

  process.stdout.write(`# bench result\n`);
  process.stdout.write(`  truth_file:        ${result.truth_file}\n`);
  process.stdout.write(`  embedding_model:   ${result.embedding_model}\n`);
  process.stdout.write(`  rerank_mode:       ${result.rerank_mode}\n`);
  process.stdout.write(`  k:                 ${result.k}\n`);
  process.stdout.write(`  total queries:     ${result.total}\n`);
  const top1Pct = result.total > 0 ? result.top1 / result.total : 0;
  const top3Pct = result.total > 0 ? result.top3 / result.total : 0;
  const topKPct = result.total > 0 ? result.topK / result.total : 0;
  process.stdout.write(`  top-1 accuracy:    ${result.top1}/${result.total}  (${(top1Pct * 100).toFixed(1)}%)\n`);
  process.stdout.write(`  top-3 accuracy:    ${result.top3}/${result.total}  (${(top3Pct * 100).toFixed(1)}%)\n`);
  process.stdout.write(`  top-${k} accuracy:    ${result.topK}/${result.total}  (${(topKPct * 100).toFixed(1)}%)\n`);
  process.stdout.write(`  mean top-1 score:  ${result.mean_top1_score.toFixed(4)}\n`);
  process.stdout.write(`  mean margin:       ${result.mean_margin.toFixed(4)}\n`);
  process.stdout.write(`  elapsed:           ${result.elapsed_ms}ms\n`);

  if (result.failures.length > 0) {
    process.stdout.write(`\n# top-1 failures (${result.failures.length}):\n`);
    for (const f of result.failures.slice(0, 10)) {
      const got = f.got_top1.split("/").at(-1) ?? f.got_top1;
      process.stdout.write(
        `  rank=${f.rank ?? "miss"}  expected=${f.expected.padEnd(20)} got=${got}\n`,
      );
      process.stdout.write(`    intent: ${f.intent}\n`);
    }
    if (result.failures.length > 10) {
      process.stdout.write(`  ... and ${result.failures.length - 10} more\n`);
    }
  }

  if (threshold > 0 && top1Pct < threshold) {
    process.stderr.write(
      `\nFAIL — top-1 accuracy ${(top1Pct * 100).toFixed(1)}% below threshold ${(threshold * 100).toFixed(1)}%\n`,
    );
    return 1;
  }
  return 0;
};

// ─── memory subcommands ────────────────────────────────────────────────────

const requireMemory = async (
  args: Args,
): Promise<{ memory: Memory; policy: Policy } | { error: string }> => {
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  if (!policy.memory.enabled) {
    return {
      error: `memory disabled in policy. Pass --policy with memory.enabled: true (or use examples/policy.live-test.yaml as a starting point).`,
    };
  }
  const embedder = resolveEmbedderOrStub();
  const memory = await buildMemoryIfEnabled(policy, embedder);
  if (!memory) return { error: "memory init failed" };
  return { memory, policy };
};

const cmdRecall = async (args: Args, label = "recall"): Promise<number> => {
  // `harness search` and `harness recall` share this implementation.
  // The label only changes the error prefix.
  const query = args.positional.join(" ");
  if (!query) {
    process.stderr.write(`harness ${label}: <query> required\n`);
    return 64;
  }
  const got = await requireMemory(args);
  if ("error" in got) {
    process.stderr.write(`harness ${label}: ${got.error}\n`);
    return 78;
  }
  const topK = Number(args.flags.get("topK") ?? "5") || 5;
  const budgetFlag = args.flags.get("budget");
  const charBudget = typeof budgetFlag === "string"
    ? Number(budgetFlag) || undefined
    : undefined;
  const sessionFlag = args.flags.get("session");
  const kindFlag = args.flags.get("kind");

  const hits = await got.memory.recall(query, {
    topK,
    ...(charBudget !== undefined ? { charBudget } : {}),
    ...(typeof sessionFlag === "string" ? { sessionId: sessionFlag } : {}),
    ...(typeof kindFlag === "string" ? { kind: kindFlag } : {}),
  });
  if (hits.length === 0) {
    process.stderr.write("no matches.\n");
    return 0;
  }
  process.stdout.write(`# ${hits.length} hit(s) for: ${query}\n\n`);
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const sim = h.similarity !== undefined ? `  similarity=${h.similarity.toFixed(3)}` : "";
    const session = h.sessionId !== undefined ? `  session=${h.sessionId}` : "";
    process.stdout.write(`[${i + 1}] ${h.kind}  ${h.ts}${sim}${session}\n`);
    process.stdout.write(`    ${h.content.replace(/\n/g, "\n    ")}\n\n`);
  }
  return 0;
};

const cmdMemoryList = async (args: Args): Promise<number> => {
  const got = await requireMemory(args);
  if ("error" in got) {
    process.stderr.write(`harness memory list: ${got.error}\n`);
    return 78;
  }
  const limit = Number(args.flags.get("limit") ?? "100") || 100;
  const kindFlag = args.flags.get("kind");
  const records = await got.memory.list({
    limit,
    ...(typeof kindFlag === "string" ? { kind: kindFlag } : {}),
  });
  if (records.length === 0) {
    process.stderr.write("no memories.\n");
    return 0;
  }
  process.stderr.write(`# ${records.length} memorie(s):\n`);
  for (const r of records) {
    process.stdout.write(`${r.id}  ${r.kind.padEnd(10)} ${r.ts}  ${r.title}\n`);
  }
  return 0;
};

const cmdMemoryForget = async (args: Args): Promise<number> => {
  // positional[0] is "forget" (parent), positional[1] is the id (if any).
  const id = args.positional[1];
  const kind = typeof args.flags.get("kind") === "string"
    ? (args.flags.get("kind") as string)
    : undefined;
  const sessionId = typeof args.flags.get("session") === "string"
    ? (args.flags.get("session") as string)
    : undefined;
  if (!id && !kind && !sessionId) {
    process.stderr.write(
      "harness memory forget: pass <id>, --kind <k>, or --session <id>\n",
    );
    return 64;
  }
  const got = await requireMemory(args);
  if ("error" in got) {
    process.stderr.write(`harness memory forget: ${got.error}\n`);
    return 78;
  }
  const filter = {
    ...(id !== undefined ? { id } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  const deleted = await got.memory.forget(filter);
  process.stdout.write(`forgot ${deleted} memorie(s)\n`);
  return 0;
};

const cmdMemoryStats = async (args: Args): Promise<number> => {
  const got = await requireMemory(args);
  if ("error" in got) {
    process.stderr.write(`harness memory stats: ${got.error}\n`);
    return 78;
  }
  const all = await got.memory.list({ limit: 100_000 });
  const byKind = new Map<string, number>();
  let oldestTs = "";
  let newestTs = "";
  for (const r of all) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    if (oldestTs === "" || r.ts < oldestTs) oldestTs = r.ts;
    if (r.ts > newestTs) newestTs = r.ts;
  }
  process.stdout.write(`# memory stats\n`);
  process.stdout.write(`  rootDir:    ${got.policy.memory.rootDir}\n`);
  process.stdout.write(`  total:      ${all.length}\n`);
  if (all.length > 0) {
    process.stdout.write(`  oldest:     ${oldestTs}\n`);
    process.stdout.write(`  newest:     ${newestTs}\n`);
    process.stdout.write(`  by kind:\n`);
    for (const [k, n] of [...byKind.entries()].sort()) {
      process.stdout.write(`    ${k.padEnd(12)} ${n}\n`);
    }
  }
  return 0;
};

const cmdMemoryExport = async (args: Args): Promise<number> => {
  const path = args.positional[1];
  if (!path) {
    process.stderr.write("harness memory export: <path> required\n");
    return 64;
  }
  const got = await requireMemory(args);
  if ("error" in got) {
    process.stderr.write(`harness memory export: ${got.error}\n`);
    return 78;
  }
  // Walk via list + recall-by-id-equivalent. The Memory interface's recall
  // returns full content, so we use it with a generic query and a high
  // topK + no budget to drain everything.
  const all = await got.memory.list({ limit: 100_000 });
  if (all.length === 0) {
    process.stderr.write("no memories to export.\n");
    return 0;
  }
  // For each shallow record, fetch full content via recall (single-record
  // pull is fine — wiki similarity is irrelevant when we want exact id).
  // TODO: a Memory.get(id) would be cleaner; today we re-recall with the
  // title as the query and filter to that id. Workable for v0.1.6.
  const records: Array<{
    id: string;
    title: string;
    kind: string;
    ts: string;
    content: string | null;
  }> = [];
  for (const item of all) {
    const hits = await got.memory.recall(item.title, { topK: 50 });
    const match = hits.find((h) => h.id === item.id);
    records.push({
      id: item.id,
      title: item.title,
      kind: item.kind,
      ts: item.ts,
      content: match?.content ?? null,
    });
  }
  await (await import("node:fs/promises")).writeFile(
    path,
    JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2),
    "utf8",
  );
  process.stdout.write(
    `exported ${records.length} memorie(s) to ${path}\n`,
  );
  if (records.some((r) => r.content === null)) {
    const missing = records.filter((r) => r.content === null).length;
    process.stderr.write(
      `warning: ${missing} record(s) had no recoverable content (recall didn't surface them); use 'harness recall' to investigate\n`,
    );
  }
  return 0;
};

const cmdMemoryRemember = async (args: Args): Promise<number> => {
  // positional[0] is "remember", positional[1..] is the content
  const content = args.positional.slice(1).join(" ");
  if (!content) {
    process.stderr.write("harness memory remember: <content> required\n");
    return 64;
  }
  const got = await requireMemory(args);
  if ("error" in got) {
    process.stderr.write(`harness memory remember: ${got.error}\n`);
    return 78;
  }
  const kind = typeof args.flags.get("kind") === "string"
    ? (args.flags.get("kind") as string)
    : "fact";
  const sessionFlag = args.flags.get("session");
  const id = await got.memory.remember(content, {
    kind,
    ...(typeof sessionFlag === "string" ? { sessionId: sessionFlag } : {}),
  });
  process.stdout.write(`${id}\n`);
  return 0;
};

const cmdRekeyCleanupBackups = async (args: Args): Promise<number> => {
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);

  // Roots that may contain backup dirs: sessions root (for per-session
  // bank backups), memory root (for memory bank backups), skills root
  // (for the skills bank backups, no-op today but future-proofed).
  const roots: string[] = [policy.paths.sessionsRoot];
  if (policy.memory.enabled) roots.push(policy.memory.rootDir);
  roots.push(policy.paths.skillsBankDir ?? defaultBankRoot());

  const olderThanFlag = args.flags.get("older-than");
  let olderThanMs: number | undefined;
  if (typeof olderThanFlag === "string") {
    const parsed = parseDuration(olderThanFlag);
    if (parsed === null) {
      process.stderr.write(
        `harness rekey --cleanup-backups: invalid --older-than value '${olderThanFlag}'. Expected forms: 7d, 2h, 30m, 60s, or raw ms.\n`,
      );
      return 64;
    }
    olderThanMs = parsed;
  }

  // Default to dry-run (apply: false). User must pass --yes or --apply
  // to actually delete. This is intentionally conservative — `rm -rf`
  // on encrypted backup dirs is irreversible.
  const apply = args.flags.get("yes") === true || args.flags.get("apply") === true;

  const result = await cleanupBackups({
    roots,
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
    apply,
    log: (line) => process.stdout.write(line + "\n"),
  });

  process.stdout.write(
    `\nfound: ${result.found.length}, eligible: ${result.eligible.length}` +
      `, skipped-orphans: ${result.skippedOrphans.length}` +
      `, deleted: ${result.deleted.length}` +
      `, errors: ${result.errors.length}\n`,
  );

  if (!apply && result.eligible.length > 0) {
    process.stdout.write(
      `\nDRY RUN — no backups were deleted. Re-run with --yes (or --apply) to actually delete.\n`,
    );
  }

  if (result.skippedOrphans.length > 0) {
    process.stderr.write(
      `\nskipped ${result.skippedOrphans.length} orphan backup(s) — their live dir is missing, ` +
        `and the backup is the only copy of the data. Investigate manually before deleting.\n`,
    );
  }

  if (result.errors.length > 0) {
    process.stderr.write("\nerrors:\n");
    for (const e of result.errors) process.stderr.write(`  ${e.dir}: ${e.message}\n`);
    return 1;
  }
  return 0;
};

const cmdRekey = async (args: Args): Promise<number> => {
  // Issue #15: harness rekey --cleanup-backups [--older-than <duration>] [--yes]
  // Sweeps `<dir>.rekey-backup-<ts>` dirs left by previous rekeys. Refuses
  // to delete a backup whose live counterpart is missing (only-copy guard).
  if (args.flags.get("cleanup-backups") === true) {
    return cmdRekeyCleanupBackups(args);
  }

  const targetFlag = (args.flags.get("target") as string | true | undefined);
  const target: RekeyTarget =
    targetFlag === "sessions" ||
    targetFlag === "memory" ||
    targetFlag === "skills" ||
    targetFlag === "all"
      ? targetFlag
      : "all";

  const fromEnvFlag = args.flags.get("from-env");
  const toEnvFlag = args.flags.get("to-env");
  if (typeof fromEnvFlag !== "string" || typeof toEnvFlag !== "string") {
    process.stderr.write(
      "harness rekey: --from-env <var> and --to-env <var> are required\n" +
        "(passing keys on argv would expose them via `ps`; use env vars instead)\n",
    );
    return 64;
  }
  const oldKey = process.env[fromEnvFlag];
  const newKey = process.env[toEnvFlag];
  if (!oldKey || !newKey) {
    process.stderr.write(
      `harness rekey: ${fromEnvFlag}/${toEnvFlag} env vars must be set with non-empty values\n`,
    );
    return 64;
  }
  if (oldKey === newKey) {
    process.stderr.write(`harness rekey: old and new keys are identical — refusing\n`);
    return 64;
  }

  const dryRun = args.flags.get("dry-run") === true;
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);

  const result = await runRekey({
    sessionsRoot: policy.paths.sessionsRoot,
    ...(policy.memory.enabled ? { memoryRoot: policy.memory.rootDir } : {}),
    // Skills bank is no-op for rekey today (no encryption), but pass it
    // through so a future encrypted skills bank covers approval_stats.
    skillsRoot: policy.paths.skillsBankDir ?? defaultBankRoot(),
    target,
    oldKey,
    newKey,
    ...(policy.encryption.saltSession !== undefined ? { saltSession: policy.encryption.saltSession } : {}),
    ...(policy.encryption.saltMemory !== undefined ? { saltMemory: policy.encryption.saltMemory } : {}),
    dryRun,
    log: (line) => process.stdout.write(line + "\n"),
  });

  if (result.errors.length > 0) {
    process.stderr.write("\nerrors:\n");
    for (const e of result.errors) {
      process.stderr.write(`  ${e.dir}: ${e.message}\n`);
    }
  }
  process.stdout.write(
    `\nresult: processed=${result.bankDirsProcessed} backups=${result.backupDirs.length} ok=${result.ok}\n`,
  );
  if (result.backupDirs.length > 0 && !dryRun) {
    process.stdout.write(`backup dir(s) (delete after verification):\n`);
    for (const b of result.backupDirs) process.stdout.write(`  ${b}\n`);
  }
  return result.ok ? 0 : 1;
};

// ─── dispatcher ─────────────────────────────────────────────────────────────

const main = async (argv: readonly string[]): Promise<number> => {
  const [, , cmd, ...rest] = argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case undefined:
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return 0;
    case "version":
    case "--version":
    case "-v":
      return cmdVersion();
    case "new":
      return withCommandError("new", args, () => cmdNew(args));
    case "do":
      return withCommandError("do", args, () => cmdDo(args));
    case "chat":
      return withCommandError("chat", args, () => cmdChat(args));
    case "resume":
      return withCommandError("resume", args, () => cmdResume(args));
    case "sessions":
      return withCommandError("sessions", args, () => cmdSessions(args));
    case "audit":
      return withCommandError("audit", args, () => cmdAudit(args));
    case "bench":
      return withCommandError("bench", args, () => cmdBench(args));
    case "recall":
      return withCommandError("recall", args, () => cmdRecall(args, "recall"));
    case "search":
      // alias for recall — friendlier name surfaced in HELP.
      return withCommandError("search", args, () => cmdRecall(args, "search"));
    case "memory":
      switch (args.positional[0]) {
        case "list":
          return withCommandError("memory list", args, () => cmdMemoryList(args));
        case "forget":
          return withCommandError("memory forget", args, () => cmdMemoryForget(args));
        case "remember":
          return withCommandError("memory remember", args, () =>
            cmdMemoryRemember(args),
          );
        case "stats":
          return withCommandError("memory stats", args, () => cmdMemoryStats(args));
        case "export":
          return withCommandError("memory export", args, () => cmdMemoryExport(args));
        case undefined:
          process.stderr.write(
            "usage: harness memory <list|forget|remember|stats|export>\n",
          );
          return 64;
        default:
          process.stderr.write(
            `unknown memory subcommand: ${args.positional[0]}\n`,
          );
          return 64;
      }
    case "rekey":
      return withCommandError("rekey", args, () => cmdRekey(args));
    case "skills":
      switch (args.positional[0]) {
        case "list":
          return withCommandError("skills list", args, () => cmdSkillsList(args));
        case "add":
          return withCommandError("skills add", args, () => cmdSkillsAdd(args));
        case undefined:
          process.stderr.write("usage: harness skills <list|add>\n");
          return 64;
        default:
          process.stderr.write(`unknown skills subcommand: ${args.positional[0]}\n`);
          return 64;
      }
    default:
      process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
      return 64;
  }
};

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  },
);
