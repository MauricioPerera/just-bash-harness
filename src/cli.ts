#!/usr/bin/env node
// Entry point. Wires the layers from src/* into a single-binary CLI.
//
// v0 surface:
//   harness new [--policy <path>]
//   harness chat <sessionId> [--message <txt>] [--model <id>]
//   harness skills list
//   harness skills add <pack@version>           (delegates to agent-skills-cli runSync)
//   harness resume <sessionId>

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";

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
import { parseArgs, type Args } from "./cli-args.js";
import type { Policy, SessionId } from "./types.js";

const HELP = `harness — agentic harness on just-bash

Usage:
  harness new [--policy <path>]
  harness chat <sessionId> [--message <txt>] [--model <id>]
  harness skills list
  harness skills add <pack@version>
  harness resume <sessionId>

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
`;

// ─── shared deps ────────────────────────────────────────────────────────────

const resolvePolicyPath = (flags: Map<string, string | true>): string | undefined => {
  const v = flags.get("policy");
  if (typeof v === "string") return v;
  return process.env["HARNESS_POLICY"] ?? undefined;
};

const loadPolicyOrDefault = async (path: string | undefined): Promise<Policy> => {
  if (!path) return DEFAULT_POLICY;
  return loadPolicy(path);
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

// ─── subcommands ────────────────────────────────────────────────────────────

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

  const turn = await runTurn(
    { provider, toolbox, approval, session: sessionStore, policy },
    {
      sessionId,
      userMessage,
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
    process.stderr.write(`[turn ${turn.id} ran ${turn.output.toolCalls.length} tool call(s)]\n`);
  }
  return turn.output.stopReason === "error" ? 1 : 0;
};

const cmdSkillsList = async (args: Args): Promise<number> => {
  const policyPath = resolvePolicyPath(args.flags);
  const policy = await loadPolicyOrDefault(policyPath);
  const embedder = resolveEmbedderOrStub();
  const bank = await ensureBank(policy, embedder);

  const skills = await bank.listSkills();
  if (skills.length === 0) {
    process.stderr.write("no skills subscribed. Use 'harness skills add <pack@version>'.\n");
    return 0;
  }
  for (const s of skills) {
    process.stdout.write(`${s.identity}\n`);
    process.stdout.write(`  title:     ${s.title}\n`);
    process.stdout.write(`  use_when:  ${s.use_when}\n`);
    process.stdout.write(`  signature: ${s.provenance.signature_status ?? "unsigned"}\n`);
    process.stdout.write("\n");
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
    process.stdout.write(`  last:     ${last.id} (${last.ts}, stop=${last.output.stopReason})\n`);
  }
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
    case "new":
      return cmdNew(args);
    case "chat":
      return cmdChat(args);
    case "resume":
      return cmdResume(args);
    case "skills":
      switch (args.positional[0]) {
        case "list":
          return cmdSkillsList(args);
        case "add":
          return cmdSkillsAdd(args);
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

void readFile; // satisfy unused-import in stub paths
