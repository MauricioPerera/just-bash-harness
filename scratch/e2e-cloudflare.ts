// Live E2E against Cloudflare Workers AI (Gemma-4 26B by default).
// Requires:
//   CF_ACCOUNT_ID, CF_API_TOKEN
// Optional:
//   CF_LLM_MODEL  (default: @cf/google/gemma-4-26b-a4b-it)
//
// What it does:
//   1. Builds a fresh FileBank with a single `echo` skill.
//   2. Asks Gemma to use the echo skill to print "hello world".
//   3. Runs one full turn through the harness loop with auto-allow approval.
//   4. Reports: text emitted, tool calls observed, exec result, audit count.
//
// Usage:
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... npx tsx scratch/e2e-cloudflare.ts

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileBank,
  type IndexedSkill,
} from "@rckflr/agent-skills-cli";

import { createToolbox } from "../src/toolbox.js";
import { createSessionStore } from "../src/session.js";
import { createApprovalGate } from "../src/approval.js";
import { runTurn } from "../src/loop.js";
import { createCloudflareProvider } from "../src/provider-cloudflare.js";
import type { Policy } from "../src/types.js";

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const echoSkill: IndexedSkill = {
  identity:
    "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo",
  schema_version: "0.1",
  id: "echo",
  version: "1.0.0",
  title: "Echo",
  description: "Prints the given message to stdout.",
  use_when: "the user wants to print or echo a string",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
  // Mark as idempotent + signed so it's auto-allow under default policy.
  idempotent: true,
  provenance: {
    source_type: "git",
    source: "github.com/test/pack",
    ref_resolved_to: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    fetched_at: "2026-04-28T00:00:00Z",
    signature_status: "valid",
  },
  embedding: stubVec(),
  embedding_model: "stub:fnv1a-32",
  inserted_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
};

const policy: Policy = {
  version: 1,
  skills: { subscribed: [], overrides: {} },
  signature: { require_signed: true },
  approval: {
    matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
  },
  limits: { maxTurns: 50, maxToolCallsPerTurn: 10, maxWallclockMs: 120_000 },
  paths: { sessionsRoot: "" },
};

const main = async (): Promise<void> => {
  const accountId = process.env["CF_ACCOUNT_ID"];
  const apiToken = process.env["CF_API_TOKEN"];
  if (!accountId || !apiToken) {
    console.error("CF_ACCOUNT_ID and CF_API_TOKEN required.");
    process.exit(78);
  }

  const skillsRoot = await mkdtemp(join(tmpdir(), "e2e-cf-skills-"));
  const sessionsRoot = await mkdtemp(join(tmpdir(), "e2e-cf-sess-"));

  try {
    const bank = new FileBank({ rootDir: skillsRoot });
    await bank.initMeta({
      embedding_model: "stub:fnv1a-32",
      embedding_dim: 32,
    });
    await bank.upsertSkill(echoSkill);

    const fullPolicy: Policy = {
      ...policy,
      paths: { sessionsRoot },
    };

    const sessionStore = createSessionStore({
      sessionsRoot,
      loadPolicy: () => Promise.resolve(fullPolicy),
    });
    const toolbox = createToolbox({
      bank,
      embedder: { name: "stub", dim: 32, embed: async () => stubVec() },
    });
    const approval = createApprovalGate({
      policy: fullPolicy,
      audit: async () => undefined,
    });

    const model = process.env["CF_LLM_MODEL"] ?? "@cf/google/gemma-4-26b-a4b-it";
    const provider = createCloudflareProvider({
      accountId,
      apiToken,
      model,
      maxTokens: 1024,
    });

    const sessionId = await sessionStore.create({
      policyPath: "<test>",
      sessionRoot: sessionsRoot,
    });

    console.log("=".repeat(70));
    console.log(`HARNESS E2E — CLOUDFLARE (${model})`);
    console.log("=".repeat(70));
    console.log(`session: ${sessionId}`);
    console.log("");
    console.log(`> hello, please use the 'echo' tool to print "hello world"`);
    console.log("");

    let textBuffer = "";
    const turn = await runTurn(
      { provider, toolbox, approval, session: sessionStore, policy: fullPolicy },
      {
        sessionId,
        userMessage:
          'Please use the "echo" tool to print exactly: hello world',
        handlers: {
          onText: (delta) => {
            textBuffer += delta;
            process.stdout.write(delta);
          },
          onToolCall: (id, skillId) => {
            process.stderr.write(`\n[tool_call ${id} → ${skillId}]\n`);
          },
        },
      },
    );

    console.log("\n");
    console.log("─── outcome ───────────────────────────────────────────────────");
    console.log(`  stop:        ${turn.output.stopReason}`);
    console.log(`  text bytes:  ${textBuffer.length}`);
    console.log(`  tool calls:  ${turn.output.toolCalls.length}`);
    for (const tc of turn.output.toolCalls) {
      console.log(`    → ${tc.skillId} args=${JSON.stringify(tc.args)}`);
    }
    if (turn.input.toolResults) {
      for (const tr of turn.input.toolResults) {
        console.log(
          `    result(${tr.callId}): exit=${tr.result.exitCode} stdout=${JSON.stringify(tr.result.stdout)}`,
        );
      }
    }
    const audit = await bank.listAudit({ limit: 10 });
    console.log(`  audit:       ${audit.length} entr${audit.length === 1 ? "y" : "ies"}`);
    console.log("───────────────────────────────────────────────────────────────");

    const usedTool = turn.output.toolCalls.length >= 1;
    const echoed = turn.input.toolResults?.some((r) =>
      r.result.stdout.toLowerCase().includes("hello world"),
    ) ?? false;
    if (usedTool && echoed) {
      console.log("PASS — Gemma called the echo tool and the output reached the harness.");
      process.exit(0);
    }
    console.log("PARTIAL — provider responded but expected tool flow not observed.");
    process.exit(1);
  } finally {
    await rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessionsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

main().catch((err) => {
  console.error("e2e-cloudflare crashed:", err);
  process.exit(2);
});
