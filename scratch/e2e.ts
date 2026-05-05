// End-to-end orchestration smoke. Validates AC#2 / AC#3 from DESIGN.md §8
// WITHOUT needing an Anthropic API key — the LLM is replaced by a scripted
// provider that emits a hardcoded event sequence per scenario.
//
// Tests:
//   A. Regular skill auto-allows; tool runs; turn persisted; audit has entry.
//   B. Explicit skill asks; user allows; tool runs.
//   C. Explicit skill asks; user denies; tool result is synthetic denial.
//   D. Prohibited skill (signed-required + unsigned) hard-denies; never asks.
//   E. Zero tool calls (text only); loop terminates with end_turn cleanly.

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
  PendingAction,
  Policy,
  Provider,
  SessionId,
  SkillId,
  TurnEvent,
  TurnInput,
} from "../src/types.js";

// ─── helpers ───────────────────────────────────────────────────────────────

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const buildSkill = (overrides: Partial<IndexedSkill>): IndexedSkill => ({
  identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo-skill",
  schema_version: "0.1",
  id: "echo-skill",
  version: "1.0.0",
  title: "Echo",
  description: "Echoes a message",
  use_when: "the user wants to print a string",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
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
  ...overrides,
});

const buildPolicy = (overrides: Partial<Policy> = {}): Policy => ({
  version: 1,
  skills: { subscribed: [], overrides: {} },
  signature: { require_signed: false },
  approval: {
    matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
  },
  limits: { maxTurns: 50, maxToolCallsPerTurn: 10, maxWallclockMs: 60_000 },
  paths: { sessionsRoot: "" },
  memory: {
    enabled: false,
    rootDir: "",
    recall: { topK: 5, charBudget: 6000 },
    persist: { autoPersistTurns: false, minMessageLength: 20 },
    compaction: { enabled: false, windowSize: 50 },
  },
  encryption: { enabled: false },
  ...overrides,
});

/** Provider that yields scripted event arrays per turn() call. */
const scriptedProvider = (scripts: ReadonlyArray<readonly TurnEvent[]>): Provider => {
  let i = 0;
  return {
    async *turn(_input: TurnInput): AsyncIterable<TurnEvent> {
      const script = scripts[i++] ?? [];
      for (const evt of script) yield evt;
    },
  };
};

const skillIdentity =
  "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo-skill" as SkillId;

interface Outcome {
  scenario: string;
  ok: boolean;
  detail: unknown;
  error?: string;
}

const expect = (
  scenario: string,
  cond: boolean,
  detail: unknown,
): Outcome => ({ scenario, ok: cond, detail });

// ─── scenario runners ──────────────────────────────────────────────────────

interface SetupOpts {
  scenario: string;
  skill: IndexedSkill;
  policyOverride?: Partial<Policy>;
  scripts: ReadonlyArray<readonly TurnEvent[]>;
  onAsk?: (action: PendingAction) => Promise<"allow" | "deny">;
}

const runScenario = async (opts: SetupOpts): Promise<Outcome> => {
  const skillsRoot = await mkdtemp(join(tmpdir(), `e2e-${opts.scenario}-skills-`));
  const sessionsRoot = await mkdtemp(join(tmpdir(), `e2e-${opts.scenario}-sess-`));

  try {
    const bank = new FileBank({ rootDir: skillsRoot });
    await bank.initMeta({ embedding_model: "stub:fnv1a-32", embedding_dim: 32 });
    await bank.upsertSkill(opts.skill);

    const policy = buildPolicy({
      ...(opts.policyOverride ?? {}),
      paths: { sessionsRoot },
    });

    const sessionStore = createSessionStore({
      sessionsRoot,
      loadPolicy: () => Promise.resolve(policy),
    });
    const toolbox = createToolbox({
      bank,
      // Stub embedder shape — toolbox only uses .embed() during resolve(),
      // and our scripted provider bypasses resolve(); it goes straight to
      // tool_call by id. So embedder is effectively unused here.
      embedder: { name: "stub", dim: 32, embed: async () => stubVec() },
    });
    const approval = createApprovalGate({ policy, audit: async () => undefined });
    const provider = scriptedProvider(opts.scripts);

    const sessionId = await sessionStore.create({
      policyPath: "<test>",
      sessionRoot: sessionsRoot,
    });

    const handlers = {
      ...(opts.onAsk ? { onApprovalAsk: opts.onAsk } : {}),
    };

    const turn = await runTurn(
      { provider, toolbox, approval, session: sessionStore, policy },
      {
        sessionId,
        userMessage: "hello",
        ...(Object.keys(handlers).length > 0 ? { handlers } : {}),
      },
    );

    // Read back what was persisted.
    const reloaded = await sessionStore.load(sessionId);
    const auditEntries = await bank.listAudit({ limit: 50 });

    return expect(opts.scenario, true, {
      stopReason: turn.output.stopReason,
      toolCalls: turn.output.toolCalls.length,
      approvals: turn.approvals.map((a) => ({
        decision: a.decision,
        source: a.source,
        category: a.action.category,
        derivedFrom: a.action.derivedFrom,
      })),
      persistedTurns: reloaded.turns.length,
      auditEntries: auditEntries.length,
      toolResultPreview: turn.input.toolResults?.[0]?.result ?? null,
    });
  } catch (err) {
    return {
      scenario: opts.scenario,
      ok: false,
      detail: null,
      error: String(err),
    };
  } finally {
    await rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessionsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

// ─── scenarios ─────────────────────────────────────────────────────────────

const scenarioA = (): Promise<Outcome> =>
  runScenario({
    scenario: "A-regular-auto-allow",
    skill: buildSkill({ idempotent: true }), // → regular
    scripts: [
      [
        { type: "text", delta: "I'll echo for you. " },
        { type: "tool_call", id: "tu_1", skill: skillIdentity, args: { msg: "hi" } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text", delta: "Done." },
        { type: "stop", reason: "end_turn" },
      ],
    ],
  });

const scenarioB = (): Promise<Outcome> =>
  runScenario({
    scenario: "B-explicit-user-allow",
    skill: buildSkill({ idempotent: false }), // → explicit (non-idempotent)
    scripts: [
      [
        { type: "tool_call", id: "tu_1", skill: skillIdentity, args: { msg: "hi" } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text", delta: "Done." },
        { type: "stop", reason: "end_turn" },
      ],
    ],
    onAsk: async () => "allow",
  });

const scenarioC = (): Promise<Outcome> =>
  runScenario({
    scenario: "C-explicit-user-deny",
    skill: buildSkill({ idempotent: false }),
    scripts: [
      [
        { type: "tool_call", id: "tu_1", skill: skillIdentity, args: { msg: "hi" } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text", delta: "OK, I won't run it." },
        { type: "stop", reason: "end_turn" },
      ],
    ],
    onAsk: async () => "deny",
  });

const scenarioD = (): Promise<Outcome> =>
  runScenario({
    scenario: "D-prohibited-hard-deny",
    skill: buildSkill({ idempotent: true }), // would be regular
    policyOverride: { signature: { require_signed: true } }, // forces prohibited
    scripts: [
      [
        { type: "tool_call", id: "tu_1", skill: skillIdentity, args: { msg: "hi" } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text", delta: "Sorry, can't run unsigned skills." },
        { type: "stop", reason: "end_turn" },
      ],
    ],
    // No onAsk — prohibited never asks.
  });

const scenarioE = (): Promise<Outcome> =>
  runScenario({
    scenario: "E-text-only",
    skill: buildSkill({ idempotent: true }),
    scripts: [
      [
        { type: "text", delta: "Hello there." },
        { type: "stop", reason: "end_turn" },
      ],
    ],
  });

// ─── runner ────────────────────────────────────────────────────────────────

interface Validation {
  ok: boolean;
  reasons: string[];
}

const validate = (outcome: Outcome): Validation => {
  if (!outcome.ok) return { ok: false, reasons: [outcome.error ?? "unknown error"] };
  const d = outcome.detail as {
    stopReason: string;
    toolCalls: number;
    approvals: Array<{ decision: string; source: string; category: string; derivedFrom: string[] }>;
    persistedTurns: number;
    auditEntries: number;
    toolResultPreview: { ok?: boolean; exitCode?: number; stderr?: string } | null;
  };
  const reasons: string[] = [];
  switch (outcome.scenario) {
    case "A-regular-auto-allow":
      if (d.stopReason !== "end_turn") reasons.push(`stopReason=${d.stopReason}`);
      if (d.toolCalls !== 1) reasons.push(`toolCalls=${d.toolCalls}`);
      if (d.approvals.length !== 1) reasons.push(`approvals=${d.approvals.length}`);
      if (d.approvals[0]?.decision !== "allow") reasons.push("decision != allow");
      if (d.approvals[0]?.source !== "policy") reasons.push("source != policy");
      if (d.approvals[0]?.category !== "regular") reasons.push("category != regular");
      if (d.persistedTurns !== 1) reasons.push(`persistedTurns=${d.persistedTurns}`);
      if (d.auditEntries < 1) reasons.push("audit empty");
      if (d.toolResultPreview?.ok !== true) reasons.push("tool not ok");
      break;
    case "B-explicit-user-allow":
      if (d.stopReason !== "end_turn") reasons.push(`stopReason=${d.stopReason}`);
      if (d.approvals[0]?.decision !== "allow") reasons.push("decision != allow");
      if (d.approvals[0]?.source !== "user") reasons.push("source != user");
      if (d.approvals[0]?.category !== "explicit") reasons.push("category != explicit");
      if (d.toolResultPreview?.ok !== true) reasons.push("tool not ok");
      break;
    case "C-explicit-user-deny":
      if (d.approvals[0]?.decision !== "deny") reasons.push("decision != deny");
      if (d.approvals[0]?.source !== "user") reasons.push("source != user");
      if (d.toolResultPreview?.ok !== false) reasons.push("tool result should be !ok");
      if (d.toolResultPreview?.exitCode !== 126) reasons.push(`exitCode=${d.toolResultPreview?.exitCode}`);
      break;
    case "D-prohibited-hard-deny":
      if (d.approvals[0]?.decision !== "deny") reasons.push("decision != deny");
      if (d.approvals[0]?.source !== "policy") reasons.push("source != policy (hard-deny is policy-source)");
      if (d.approvals[0]?.category !== "prohibited") reasons.push("category != prohibited");
      if (d.toolResultPreview?.ok !== false) reasons.push("tool result should be !ok");
      break;
    case "E-text-only":
      if (d.stopReason !== "end_turn") reasons.push(`stopReason=${d.stopReason}`);
      if (d.toolCalls !== 0) reasons.push(`toolCalls=${d.toolCalls}`);
      if (d.approvals.length !== 0) reasons.push(`approvals=${d.approvals.length}`);
      if (d.persistedTurns !== 1) reasons.push(`persistedTurns=${d.persistedTurns}`);
      break;
  }
  return { ok: reasons.length === 0, reasons };
};

const main = async (): Promise<void> => {
  const outcomes = await Promise.all([
    scenarioA(),
    scenarioB(),
    scenarioC(),
    scenarioD(),
    scenarioE(),
  ]);

  console.log("=".repeat(70));
  console.log("HARNESS E2E ORCHESTRATION — RESULTS");
  console.log("=".repeat(70));
  let passed = 0;
  for (const o of outcomes) {
    const v = validate(o);
    const tag = v.ok ? "PASS" : "FAIL";
    if (v.ok) passed++;
    console.log(`\n[${tag}] ${o.scenario}`);
    if (!v.ok) {
      for (const r of v.reasons) console.log(`  · ${r}`);
    }
    console.log("  detail:", JSON.stringify(o.detail, null, 2)
      .split("\n").map((l, i) => i === 0 ? l : "          " + l).join("\n"));
  }
  console.log("\n" + "=".repeat(70));
  console.log(`${passed} / ${outcomes.length} scenarios passed`);
  console.log("=".repeat(70));
  process.exit(passed === outcomes.length ? 0 : 1);
};

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(2);
});
