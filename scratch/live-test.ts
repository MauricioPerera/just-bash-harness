// Live end-to-end driver: REAL session in ~/.harness/sessions/ produced by
// REAL Gemma decisions captured via the Cloudflare MCP connector in the
// parent agent session. Persisted on purpose so the new CLI commands
// (sessions / audit / resume) can be exercised against it afterwards.
//
// Skills bank is a tmp dir to avoid polluting the user's default bank;
// consequence: the `bank audit` block of `harness audit` will be empty.
// Session-side approvals will be present and complete.

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { FileBank, type IndexedSkill } from "@rckflr/agent-skills-cli";

import { createToolbox } from "../src/toolbox.js";
import { createSessionStore } from "../src/session.js";
import { createApprovalGate } from "../src/approval.js";
import { runTurn } from "../src/loop.js";
import type {
  Policy,
  Provider,
  SkillId,
  TurnEvent,
  TurnInput,
} from "../src/types.js";

// ────────────────────────────────────────────────────────────────────────
// Live Gemma capture from parent agent session, 2026-05-04
// User prompt: "Use the echo tool to print: 'just-bash-harness v0.1.3 ready'"
// Two MCP calls to /accounts/<id>/ai/run/@cf/google/gemma-4-26b-a4b-it
// ────────────────────────────────────────────────────────────────────────

const SKILL_IDENTITY =
  "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo" as SkillId;

const GEMMA_TURN_1: TurnEvent[] = [
  {
    type: "tool_call",
    id: "chatcmpl-tool-9599215e16bf401a",
    skill: SKILL_IDENTITY,
    args: { msg: "just-bash-harness v0.1.3 ready" },
  },
  { type: "stop", reason: "tool_use" },
];

const GEMMA_TURN_2: TurnEvent[] = [
  { type: "text", delta: "OK." },
  { type: "stop", reason: "end_turn" },
];

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const echoSkill: IndexedSkill = {
  identity: SKILL_IDENTITY,
  schema_version: "0.1",
  id: "echo",
  version: "1.0.0",
  title: "Echo",
  description: "Echoes a message to stdout",
  use_when: "the user wants to print or echo a string",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
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

const replayProvider = (
  scripts: ReadonlyArray<readonly TurnEvent[]>,
): Provider => {
  let i = 0;
  return {
    async *turn(_input: TurnInput): AsyncIterable<TurnEvent> {
      const script = scripts[i++] ?? [];
      for (const evt of script) yield evt;
    },
  };
};

const main = async (): Promise<void> => {
  // Real ~/.harness/sessions/ so `harness sessions` finds it.
  const sessionsRoot = join(homedir(), ".harness", "sessions");
  await mkdir(sessionsRoot, { recursive: true });

  // Tmp skills bank — we don't want to add a fixture skill to the user's
  // production bank. Cleaned up at end.
  const skillsRoot = await mkdtemp(join(tmpdir(), "live-test-skills-"));

  try {
    const bank = new FileBank({ rootDir: skillsRoot });
    await bank.initMeta({
      embedding_model: "stub:fnv1a-32",
      embedding_dim: 32,
    });
    await bank.upsertSkill(echoSkill);

    const policy: Policy = {
      version: 1,
      skills: { subscribed: [], overrides: {} },
      signature: { require_signed: true },
      approval: {
        matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
      },
      limits: {
        maxTurns: 50,
        maxToolCallsPerTurn: 10,
        maxWallclockMs: 60_000,
      },
      paths: { sessionsRoot, skillsBankDir: skillsRoot },
      memory: {
        enabled: false,
        rootDir: "",
        recall: { topK: 5, charBudget: 6000 },
        persist: { autoPersistTurns: false, minMessageLength: 20 },
        compaction: { enabled: false, windowSize: 50 },
      },
      encryption: { enabled: false },
    };

    const sessionStore = createSessionStore({
      sessionsRoot,
      loadPolicy: () => Promise.resolve(policy),
    });
    const toolbox = createToolbox({
      bank,
      embedder: { name: "stub", dim: 32, embed: async () => stubVec() },
    });
    const approval = createApprovalGate({
      policy,
      audit: async () => undefined,
    });
    const provider = replayProvider([GEMMA_TURN_1, GEMMA_TURN_2]);

    const sessionId = await sessionStore.create({
      policyPath: "<live-test>",
      sessionRoot: sessionsRoot,
    });

    console.log("=".repeat(70));
    console.log("LIVE TEST — real session, real Gemma decisions");
    console.log("=".repeat(70));
    console.log(`session id:  ${sessionId}`);
    console.log(`session dir: ${join(sessionsRoot, sessionId)}`);
    console.log("");
    console.log(
      `> user: Use the echo tool to print: 'just-bash-harness v0.1.3 ready'`,
    );
    console.log("");

    const turn = await runTurn(
      { provider, toolbox, approval, session: sessionStore, policy },
      {
        sessionId,
        userMessage:
          "Use the echo tool to print: 'just-bash-harness v0.1.3 ready'",
        handlers: {
          onText: (delta) =>
            process.stdout.write(`[gemma]     ${JSON.stringify(delta)}\n`),
          onToolCall: (id, skillId) => {
            const short = skillId.split("/").at(-1);
            process.stderr.write(`[tool_call] ${id} → ${short}\n`);
          },
        },
      },
    );

    console.log("");
    console.log("─── outcome ────────────────────────────────────────────");
    console.log(`  stop reason:  ${turn.output.stopReason}`);
    console.log(`  tool calls:   ${turn.output.toolCalls.length}`);
    for (const tc of turn.output.toolCalls) {
      console.log(`    ${tc.id} → ${tc.skillId.split("/").at(-1)}`);
      console.log(`      args: ${JSON.stringify(tc.args)}`);
    }
    console.log(`  approvals:    ${turn.approvals.length}`);
    for (const a of turn.approvals) {
      console.log(
        `    ${a.decision} (${a.source}, ${a.action.category}) reasons=[${a.action.derivedFrom.join(",")}]`,
      );
    }
    if (turn.input.toolResults) {
      for (const tr of turn.input.toolResults) {
        console.log(`  echo executed:`);
        console.log(`    command:  ${tr.result.command}`);
        console.log(`    stdout:   ${JSON.stringify(tr.result.stdout)}`);
        console.log(`    elapsed:  ${tr.result.elapsedMs}ms`);
      }
    }

    console.log("");
    console.log("─── exercise the polished CLI now ──────────────────────");
    console.log(`  npx tsx src/cli.ts sessions`);
    console.log(`  npx tsx src/cli.ts audit ${sessionId}`);
    console.log(`  npx tsx src/cli.ts resume ${sessionId}`);
    console.log("─────────────────────────────────────────────────────────");
  } finally {
    // Skills bank goes; session stays in ~/.harness/sessions/.
    await rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

main().catch((err) => {
  console.error("live-test crashed:", err);
  process.exit(2);
});
