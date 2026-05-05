#!/usr/bin/env node
// Entry point. Wires the layers from src/* into a single-binary CLI.
//
// v0.1.3 surface:
//   harness new [--policy <path>]
//   harness chat <sessionId> [--message <txt>] [--model <id>]
//   harness skills list
//   harness skills add <pack@version>
//   harness resume <sessionId>
//   harness sessions
//   harness audit <sessionId> [--limit N]
//   harness version

import { join } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";

import {
  FileBank,
  defaultBankRoot,
  resolveEmbedderFromEnv,
  createStubEmbedder,
  runSync,
  type EmbeddingProvider,
} from "@rckflr/agent-skills-cli";

import { createToolbox } from "./toolbox.js";
import { createSessionStore } from "./session.js";
import { createApprovalGate, promptUserApproval } from "./approval.js";
import { resolveProviderFromEnv } from "./provider.js";
import { loadPolicy, DEFAULT_POLICY } from "./policy.js";
import { runTurn } from "./loop.js";
import { createMemoryStore, type Memory } from "./memory.js";
import { parseArgs, type Args } from "./cli-args.js";
import type { Policy, SessionId } from "./types.js";

// Bumped in lockstep with package.json on each release.
const HARNESS_VERSION = "0.1.7";

const HELP = `harness — agentic harness on just-bash (v${HARNESS_VERSION})

Usage:
  harness new [--policy <path>]
  harness chat <sessionId> [--message <txt>] [--model <id>]
  harness resume <sessionId>
  harness sessions
  harness audit <sessionId> [--limit N]
  harness skills list [--all]
  harness skills add <pack@version>
  harness search <query> [--topK N] [--budget N] [--kind <k>] [--session <id>]
  harness recall <query>              (alias for search)
  harness memory list [--kind <k>] [--limit N]
  harness memory forget <id>          (or --kind <k> | --session <id>)
  harness memory remember <content> [--kind <k>] [--session <id>]
  harness memory stats
  harness memory export <path>
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

Examples:
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

/** Construct a Memory dep when policy.memory.enabled. Re-uses the embedder
 *  the harness picked for retrieval so memory + skill recall vectors stay
 *  in the same model space. */
const buildMemoryIfEnabled = async (
  policy: Policy,
  embedder: EmbeddingProvider,
): Promise<Memory | undefined> => {
  if (!policy.memory.enabled) return undefined;
  await mkdir(policy.memory.rootDir, { recursive: true });
  return createMemoryStore({ rootDir: policy.memory.rootDir, embedder });
};

/** Wrap a subcommand so that domain errors print as `harness <cmd>: <msg>`
 *  rather than reaching main's generic `fatal:` handler. Returns exit code 1
 *  on caught exception. */
const withCommandError = async (
  cmd: string,
  fn: () => Promise<number>,
): Promise<number> => {
  try {
    return await fn();
  } catch (err) {
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
  const sessionStore = createSessionStore({
    sessionsRoot,
    loadPolicy: () => Promise.resolve(policy),
  });

  const id = await sessionStore.create({
    policyPath: policyPath ?? "<default>",
    sessionRoot: sessionsRoot,
  });

  process.stdout.write(`${id}\n`);
  process.stderr.write(`session created at ${join(sessionsRoot, id)}\n`);
  return 0;
};

const cmdChat = async (args: Args): Promise<number> => {
  const sessionId = args.positional[0] as SessionId | undefined;
  if (!sessionId) {
    process.stderr.write("harness chat: <sessionId> required\n");
    return 64;
  }

  // Read user message from --message or stdin.
  let userMessage = args.flags.get("message");
  if (typeof userMessage !== "string") {
    if (process.stdin.isTTY) {
      process.stderr.write(
        "no --message provided and stdin is a TTY — pass --message \"...\" or pipe text in.\n",
      );
      return 64;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    userMessage = Buffer.concat(chunks).toString("utf8").trim();
    if (!userMessage) {
      process.stderr.write("empty stdin\n");
      return 64;
    }
  }

  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);

  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);
  const sessionsRoot = await ensureSessionsRoot(policy);

  const sessionStore = createSessionStore({
    sessionsRoot,
    loadPolicy: () => Promise.resolve(policy),
  });

  const toolbox = createToolbox({ bank, embedder });
  const approval = createApprovalGate({
    policy,
    audit: async () => {
      // Session.appendTurn already persists approvals via `db approvals`.
      // Hook here is a side-channel for real-time alerting / OTEL — no-op v0.
    },
  });

  const memory = await buildMemoryIfEnabled(policy, embedder);

  const modelOverride = args.flags.get("model");
  let provider;
  let providerChoice: "anthropic" | "cloudflare";
  let providerModel: string;
  try {
    const resolved = resolveProviderFromEnv({
      ...(typeof modelOverride === "string" ? { model: modelOverride } : {}),
    });
    provider = resolved.provider;
    providerChoice = resolved.choice;
    providerModel = resolved.model;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 78;
  }
  process.stderr.write(`[provider: ${providerChoice} / ${providerModel}]\n`);
  if (memory) {
    process.stderr.write(`[memory: enabled at ${policy.memory.rootDir}]\n`);
  }

  // SIGINT handling: first press = soft cancel (signal the loop, save what
  // we have); second press = hard exit. The loop checks signal between
  // provider events.
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) {
      process.stderr.write("\n[double SIGINT — hard exit]\n");
      process.exit(130);
    }
    interrupted = true;
    process.stderr.write(
      "\n[SIGINT — finishing current provider event then stopping; press Ctrl+C again to force]\n",
    );
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    const turn = await runTurn(
      { provider, toolbox, approval, session: sessionStore, policy, ...(memory ? { memory } : {}) },
      {
        sessionId,
        userMessage,
        signal: controller.signal,
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

    process.stdout.write(`\n[stop: ${turn.output.stopReason}]\n`);
    if (turn.output.toolCalls.length > 0) {
      process.stderr.write(
        `[turn ${turn.id} ran ${turn.output.toolCalls.length} tool call(s)]\n`,
      );
    }
    return turn.output.stopReason === "error" ? 1
      : turn.output.stopReason === "cancelled" ? 130
      : 0;
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
  const sessionStore = createSessionStore({
    sessionsRoot,
    loadPolicy: () => Promise.resolve(policy),
  });

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

const cmdSessions = async (args: Args): Promise<number> => {
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const sessionsRoot = await ensureSessionsRoot(policy);

  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("s_"));

  if (dirs.length === 0) {
    process.stderr.write(`no sessions under ${sessionsRoot}\n`);
    return 0;
  }

  // Sort newest first by mtime.
  const withStats = await Promise.all(
    dirs.map(async (d) => {
      const path = join(sessionsRoot, d.name);
      const s = await stat(path);
      return { id: d.name, mtime: s.mtime };
    }),
  );
  withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  process.stderr.write(`# ${withStats.length} session(s) under ${sessionsRoot}\n`);
  for (const e of withStats) {
    process.stdout.write(`${e.id}  ${e.mtime.toISOString()}\n`);
  }
  return 0;
};

const cmdAudit = async (args: Args): Promise<number> => {
  const sessionId = args.positional[0] as SessionId | undefined;
  if (!sessionId) {
    process.stderr.write("harness audit: <sessionId> required\n");
    return 64;
  }

  const limitFlag = args.flags.get("limit");
  const limit = typeof limitFlag === "string" ? Math.max(1, parseInt(limitFlag, 10) || 20) : 20;

  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const sessionsRoot = await ensureSessionsRoot(policy);
  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);
  const sessionStore = createSessionStore({
    sessionsRoot,
    loadPolicy: () => Promise.resolve(policy),
  });

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
      return withCommandError("new", () => cmdNew(args));
    case "chat":
      return withCommandError("chat", () => cmdChat(args));
    case "resume":
      return withCommandError("resume", () => cmdResume(args));
    case "sessions":
      return withCommandError("sessions", () => cmdSessions(args));
    case "audit":
      return withCommandError("audit", () => cmdAudit(args));
    case "recall":
      return withCommandError("recall", () => cmdRecall(args, "recall"));
    case "search":
      // alias for recall — friendlier name surfaced in HELP.
      return withCommandError("search", () => cmdRecall(args, "search"));
    case "memory":
      switch (args.positional[0]) {
        case "list":
          return withCommandError("memory list", () => cmdMemoryList(args));
        case "forget":
          return withCommandError("memory forget", () => cmdMemoryForget(args));
        case "remember":
          return withCommandError("memory remember", () =>
            cmdMemoryRemember(args),
          );
        case "stats":
          return withCommandError("memory stats", () => cmdMemoryStats(args));
        case "export":
          return withCommandError("memory export", () => cmdMemoryExport(args));
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
    case "skills":
      switch (args.positional[0]) {
        case "list":
          return withCommandError("skills list", () => cmdSkillsList(args));
        case "add":
          return withCommandError("skills add", () => cmdSkillsAdd(args));
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
