// E2E with REAL Gemma decisions, captured via the Cloudflare MCP connector
// in the parent agent session and replayed here through the harness's full
// pipeline (FileBank, runExec, ApprovalGate, SessionStore, audit).
//
// The events below were obtained from two live calls to
//   POST /accounts/<id>/ai/run/@cf/google/gemma-4-26b-a4b-it
// against the production Workers AI endpoint, using the harness's exact
// tool-schema format. They are NOT scripted by hand — the tool_call id,
// the args JSON, and the final text are byte-for-byte what Gemma returned.
//
// What the harness then does (validated by this run):
//   1. Loads policy with require_signed:false so unsigned skills resolve.
//   2. Resolves the call to the echo skill in the bank.
//   3. Derives approval category — should be `regular` (idempotent + no
//      network/filesystem) → matrix says `allow` automatically.
//   4. runExec executes the echo command in the just-bash sandbox.
//   5. Audit log appended.
//   6. Second turn iteration consumes the tool result, gets Gemma's final
//      text, persists turn.

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
import type {
  Policy,
  Provider,
  SkillId,
  TurnEvent,
  TurnInput,
} from "../src/types.js";

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const SKILL_IDENTITY =
  "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo" as SkillId;

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
  idempotent: true,        // → category: regular under default policy
  provenance: {
    source_type: "git",
    source: "github.com/test/pack",
    ref_resolved_to: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    fetched_at: "2026-04-28T00:00:00Z",
    signature_status: "unsigned",
  },
  embedding: stubVec(),
  embedding_model: "stub:fnv1a-32",
  inserted_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
};

// ────────────────────────────────────────────────────────────────────────
// Live Gemma capture from parent agent session.
// Source: two MCP calls to /accounts/{id}/ai/run/@cf/google/gemma-4-26b-a4b-it
//
//   Request 1: system + user("Use the echo tool to print exactly: ...")
//              + tools=[echo with same schema this script ships].
//   Response 1: finish_reason="tool_calls",
//               tool_calls=[{id="chatcmpl-tool-ad9981cd9497dae3",
//                            name="echo",
//                            arguments='{"msg":"harness E2E validated by Gemma at run time"}'}]
//
//   Request 2: same + assistant tool_calls + role:"tool" with
//              content="harness E2E validated by Gemma at run time\n"
//   Response 2: finish_reason="stop",
//               content="harness E2E validated by Gemma at run time"
// ────────────────────────────────────────────────────────────────────────

const GEMMA_TURN_1: TurnEvent[] = [
  {
    type: "tool_call",
    id: "chatcmpl-tool-ad9981cd9497dae3",
    skill: SKILL_IDENTITY,
    args: { msg: "harness E2E validated by Gemma at run time" },
  },
  { type: "stop", reason: "tool_use" },
];

const GEMMA_TURN_2: TurnEvent[] = [
  { type: "text", delta: "harness E2E validated by Gemma at run time" },
  { type: "stop", reason: "end_turn" },
];

const replayProvider = (scripts: ReadonlyArray<readonly TurnEvent[]>): Provider => {
  let i = 0;
  return {
    async *turn(_input: TurnInput): AsyncIterable<TurnEvent> {
      const script = scripts[i++] ?? [];
      for (const evt of script) yield evt;
    },
  };
};

const main = async (): Promise<void> => {
  const skillsRoot = await mkdtemp(join(tmpdir(), "e2e-cf-driven-skills-"));
  const sessionsRoot = await mkdtemp(join(tmpdir(), "e2e-cf-driven-sess-"));

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
      signature: { require_signed: false },
      approval: {
        matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
      },
      limits: { maxTurns: 50, maxToolCallsPerTurn: 10, maxWallclockMs: 60_000 },
      paths: { sessionsRoot },
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
      policyPath: "<test>",
      sessionRoot: sessionsRoot,
    });

    console.log("=".repeat(70));
    console.log("HARNESS E2E — REAL GEMMA DECISIONS REPLAYED THROUGH FULL PIPELINE");
    console.log("=".repeat(70));
    console.log(`session:     ${sessionId}`);
    console.log(`model:       @cf/google/gemma-4-26b-a4b-it`);
    console.log(`skill:       ${SKILL_IDENTITY}`);
    console.log("");
    console.log(`> user: Use the echo tool to print exactly: "harness E2E validated by Gemma at run time"`);
    console.log("");

    const turn = await runTurn(
      { provider, toolbox, approval, session: sessionStore, policy },
      {
        sessionId,
        userMessage:
          'Use the echo tool to print exactly: "harness E2E validated by Gemma at run time"',
        handlers: {
          onText: (delta) => process.stdout.write(`[text] ${delta}\n`),
          onToolCall: (id, skillId) =>
            process.stderr.write(`[tool_call] ${id} → ${skillId}\n`),
        },
      },
    );

    console.log("");
    console.log("─── execution outcome ─────────────────────────────────────────");
    console.log(`  stop reason:   ${turn.output.stopReason}`);
    console.log(`  text:          ${JSON.stringify(turn.output.text)}`);
    console.log(`  tool calls:    ${turn.output.toolCalls.length}`);
    for (const tc of turn.output.toolCalls) {
      console.log(`    ${tc.id} → ${tc.skillId}`);
      console.log(`      args: ${JSON.stringify(tc.args)}`);
    }
    console.log(`  approvals:     ${turn.approvals.length}`);
    for (const a of turn.approvals) {
      console.log(
        `    decision=${a.decision} source=${a.source} category=${a.action.category} reasons=[${a.action.derivedFrom.join(",")}]`,
      );
    }
    if (turn.input.toolResults) {
      console.log(`  tool results:`);
      for (const tr of turn.input.toolResults) {
        console.log(
          `    ${tr.callId}: exit=${tr.result.exitCode} elapsedMs=${tr.result.elapsedMs}`,
        );
        console.log(`      command: ${tr.result.command}`);
        console.log(`      stdout:  ${JSON.stringify(tr.result.stdout)}`);
      }
    }

    console.log("");
    console.log("─── persisted state ──────────────────────────────────────────");
    const reloaded = await sessionStore.load(sessionId);
    console.log(`  session.turns:           ${reloaded.turns.length}`);
    console.log(`  session.turns[0].id:     ${reloaded.turns[0]?.id}`);
    console.log(`  session.turns[0].calls:  ${reloaded.turns[0]?.output.toolCalls.length}`);

    const audit = await bank.listAudit({ limit: 10 });
    console.log(`  bank.audit entries:      ${audit.length}`);
    for (const e of audit) {
      console.log(`    ${e.timestamp} ${e.skill_id.split("/").at(-1)} exit=${e.exit_code} ${e.elapsed_ms}ms`);
    }
    console.log("───────────────────────────────────────────────────────────────");

    const usedTool = turn.output.toolCalls.length === 1;
    const echoed =
      turn.input.toolResults?.[0]?.result.stdout.includes(
        "harness E2E validated by Gemma at run time",
      ) ?? false;
    const persisted = reloaded.turns.length === 1;
    const audited = audit.length === 1;

    console.log("");
    if (usedTool && echoed && persisted && audited) {
      console.log("PASS — Gemma's tool decision flowed through the harness end-to-end.");
      process.exit(0);
    } else {
      console.log("FAIL");
      console.log(`  usedTool=${usedTool} echoed=${echoed} persisted=${persisted} audited=${audited}`);
      process.exit(1);
    }
  } finally {
    await rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessionsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

main().catch((err) => {
  console.error("e2e-cf-driven crashed:", err);
  process.exit(2);
});
