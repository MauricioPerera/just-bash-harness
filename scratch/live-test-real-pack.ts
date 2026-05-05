// End-to-end live test against the real `agent-skills-pack@v2.2.0`:
// - Bank populated by `harness skills add github.com/.../agent-skills-pack@v2.2.0`
// - Policy from examples/policy.live-test.yaml (require_signed: false because
//   the pack v2.2.0 doesn't have signed tags yet)
// - Gemma decisions captured live via the Cloudflare MCP connector
// - Harness loop runs the REAL base64-encode skill via just-bash, persists
//   to ~/.harness/sessions/, ready for the polished CLI to inspect.

import { FileBank } from "@rckflr/agent-skills-cli";

import { createToolbox } from "../src/toolbox.js";
import { createSessionStore } from "../src/session.js";
import { createApprovalGate } from "../src/approval.js";
import { runTurn } from "../src/loop.js";
import { loadPolicy } from "../src/policy.js";
import type { Provider, SkillId, TurnEvent, TurnInput } from "../src/types.js";

// ────────────────────────────────────────────────────────────────────────
// Live Gemma capture, 2026-05-04
// User: "Encode the string 'hello, harness!' in base64 for me."
// Tools provided: 7 from agent-skills-pack v2.2.0
// Gemma picked: base64-encode
// ────────────────────────────────────────────────────────────────────────

const SKILL_IDENTITY =
  "github.com/MauricioPerera/agent-skills-pack@955dc6f876eedaacb6817559fd24f2dc9d204383/base64-encode" as SkillId;

const GEMMA_TURN_1: TurnEvent[] = [
  {
    type: "tool_call",
    id: "chatcmpl-tool-a780096b8447e903",
    skill: SKILL_IDENTITY,
    args: { value: "hello, harness!" },
  },
  { type: "stop", reason: "tool_use" },
];

const GEMMA_TURN_2: TurnEvent[] = [
  {
    type: "text",
    delta:
      "The base64 encoded string for 'hello, harness!' is `aGVsbG8sIGhhcm5lc3Mh`.",
  },
  { type: "stop", reason: "end_turn" },
];

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

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const main = async (): Promise<void> => {
  const policy = await loadPolicy("examples/policy.live-test.yaml");
  const sessionsRoot = policy.paths.sessionsRoot;
  const skillsBankDir = policy.paths.skillsBankDir!;

  const bank = new FileBank({ rootDir: skillsBankDir });
  const skills = await bank.listSkills();
  const base64 = skills.find((s) => s.id === "base64-encode");
  if (!base64) {
    console.error("base64-encode not found in bank — run skills add first");
    process.exit(1);
  }

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
    policyPath: "examples/policy.live-test.yaml",
    sessionRoot: sessionsRoot,
  });

  console.log("=".repeat(72));
  console.log("LIVE TEST — agent-skills-pack v2.2.0 + Gemma 4 26B");
  console.log("=".repeat(72));
  console.log(`session id:  ${sessionId}`);
  console.log(`bank:        ${skillsBankDir} (${skills.length} skills)`);
  console.log(`pack:        github.com/MauricioPerera/agent-skills-pack@v2.2.0`);
  console.log("");
  console.log(`> user: Encode the string 'hello, harness!' in base64 for me.`);
  console.log("");

  const turn = await runTurn(
    { provider, toolbox, approval, session: sessionStore, policy },
    {
      sessionId,
      userMessage: "Encode the string 'hello, harness!' in base64 for me.",
      handlers: {
        onText: (delta) => process.stdout.write(`[gemma]     ${delta}\n`),
        onToolCall: (id, skillId) => {
          process.stderr.write(
            `[tool_call] ${id} → ${skillId.split("/").at(-1)}\n`,
          );
        },
      },
    },
  );

  console.log("");
  console.log("─── outcome ──────────────────────────────────────────────");
  console.log(`  stop:         ${turn.output.stopReason}`);
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
      console.log(`  runExec:`);
      console.log(`    command:  ${tr.result.command}`);
      console.log(`    stdout:   ${JSON.stringify(tr.result.stdout)}`);
      console.log(`    exit:     ${tr.result.exitCode}`);
      console.log(`    elapsed:  ${tr.result.elapsedMs}ms`);
    }
  }

  console.log("");
  console.log(`Persisted to ${sessionsRoot}/${sessionId}/`);
  console.log("");
  console.log("Try the polished CLI:");
  console.log(`  npx tsx src/cli.ts sessions --policy examples/policy.live-test.yaml`);
  console.log(`  npx tsx src/cli.ts audit ${sessionId} --policy examples/policy.live-test.yaml`);
  console.log(`  npx tsx src/cli.ts resume ${sessionId} --policy examples/policy.live-test.yaml`);
  console.log("─────────────────────────────────────────────────────────");
};

main().catch((err) => {
  console.error("live-test crashed:", err);
  process.exit(2);
});
