// SECURITY smoke: end-to-end verification that the chain-union approval
// wiring (loop.ts → approval.ts) actually fires for chain steps, not just
// for the parent skill.
//
// MOTIVATION (issue #6):
//
// Pre-v0.2.3, deriveCategory evaluated only the parent's metadata. A
// benign parent could declare a privileged chain step (e.g. network:
// ["evil.com"]) and the user would never see it at the approval prompt.
// The fix in v0.2.3 added chain steps to the evaluation: the worst
// category over [parent, ...chainSkills] wins. Unit tests in
// approval.test.ts cover the pure function thoroughly. But there is no
// existing smoke that exercises the loop.ts → approval.ts wiring
// end-to-end. If someone refactors loop.ts and forgets to pass
// chainSkills to deriveCategory, all unit tests still pass — they call
// deriveCategory directly with explicit args. The bug would land
// silently. This is exactly the v0.2.3 vulnerability shape returning.
//
// This smoke catches that. Two cases:
//
//   Case 1: parent + KNOWN privileged chain step
//     Parent: signed, idempotent, no caps → would be `regular` alone.
//     Chain step: signed, network: ["evil.com"] → escalates the union.
//     Expected: approval gate sees `category: "explicit"`, derivedFrom
//     contains `chain:<short-id> network:1`.
//
//   Case 2: parent + UNKNOWN chain step (typo'd identity)
//     Parent: signed, idempotent, no caps.
//     Chain step: skill ID points at a skill not in the bank.
//     Expected: synthesizeUnknownChainStep produces worst-case fallback
//     (unsigned, network ["*"], filesystem ["*"], non-idempotent),
//     which forces `category: "prohibited"` regardless of policy
//     permissiveness.
//
// Both cases use a custom ApprovalGate that captures the PendingAction
// and returns "deny" — no TTY scripting needed. The test asserts on the
// captured action's `derivedFrom` and `category`.
//
// If this smoke fails, the v0.2.3 chains-bypass-approval bug has either
// re-emerged or never been wired correctly to begin with.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileBank, type IndexedSkill } from "@rckflr/agent-skills-cli";

import { createToolbox } from "../src/toolbox.js";
import { createSessionStore } from "../src/session.js";
import { runTurn } from "../src/loop.js";
import type {
  ApprovalDecision,
  ApprovalGate,
  ApprovalRecord,
  PendingAction,
  Policy,
  Provider,
  SkillId,
  TurnEvent,
  TurnInput,
} from "../src/types.js";

// ─── helpers ──────────────────────────────────────────────────────────────

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const PACK = "github.com/test/chain-approval@a1b2c3d4e5f67890abcdef1234567890abcdef12";

const baseSkill = (overrides: Partial<IndexedSkill>): IndexedSkill => ({
  identity: `${PACK}/skill` as IndexedSkill["identity"],
  schema_version: "0.1",
  id: "skill",
  version: "1.0.0",
  title: "Skill",
  description: "...",
  use_when: "...",
  command_template: "echo from-skill",
  args: {},
  idempotent: true,
  provenance: {
    source_type: "git",
    source: "github.com/test/chain-approval",
    ref_resolved_to: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    fetched_at: "2026-04-28T00:00:00Z",
    signature_status: "valid",
  },
  embedding: stubVec(),
  embedding_model: "stub:fnv1a-32",
  inserted_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
  ...overrides,
});

const buildPolicy = (sessionsRoot: string, requireSigned: boolean): Policy => ({
  version: 1,
  skills: { subscribed: [], overrides: {} },
  signature: { require_signed: requireSigned },
  approval: {
    matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
  },
  limits: { maxTurns: 50, maxToolCallsPerTurn: 10, maxWallclockMs: 60_000 },
  paths: { sessionsRoot },
  memory: {
    enabled: false,
    rootDir: "",
    recall: { topK: 5, charBudget: 6000 },
    persist: { autoPersistTurns: false, minMessageLength: 20 },
    compaction: { enabled: false, windowSize: 50 },
  },
  encryption: { enabled: false },
});

const scriptedProvider = (scripts: ReadonlyArray<readonly TurnEvent[]>): Provider => {
  let i = 0;
  return {
    async *turn(_input: TurnInput): AsyncIterable<TurnEvent> {
      const script = scripts[i++] ?? [];
      for (const evt of script) yield evt;
    },
  };
};

/**
 * Capturing approval gate. Records every PendingAction and decision.
 * Always returns "deny" so we don't need to script TTY input — the
 * point of this smoke is to verify what the gate SEES, not what it
 * does after.
 */
const capturingGate = (): {
  gate: ApprovalGate;
  captured: PendingAction[];
} => {
  const captured: PendingAction[] = [];
  return {
    captured,
    gate: {
      async check(action: PendingAction): Promise<ApprovalDecision> {
        captured.push(action);
        // Hard-deny prohibited and any other returns "deny" so the
        // execution doesn't actually run.
        return "deny";
      },
      async record(_record: ApprovalRecord): Promise<void> {
        // no-op
      },
    },
  };
};

// ─── case runner ──────────────────────────────────────────────────────────

interface CaseResult {
  name: string;
  pass: boolean;
  reasons: string[];
  detail?: unknown;
}

const runCase = async (
  name: string,
  parent: IndexedSkill,
  extraSkills: IndexedSkill[],
  policy: { requireSigned: boolean },
  expect: (action: PendingAction) => string[],
): Promise<CaseResult> => {
  const skillsRoot = await mkdtemp(join(tmpdir(), `chain-approval-${name}-skills-`));
  const sessionsRoot = await mkdtemp(join(tmpdir(), `chain-approval-${name}-sess-`));

  try {
    const bank = new FileBank({ rootDir: skillsRoot });
    await bank.initMeta({ embedding_model: "stub:fnv1a-32", embedding_dim: 32 });
    await bank.upsertSkill(parent);
    for (const s of extraSkills) await bank.upsertSkill(s);

    const policyObj = buildPolicy(sessionsRoot, policy.requireSigned);
    const sessionStore = createSessionStore({
      sessionsRoot,
      loadPolicy: () => Promise.resolve(policyObj),
    });
    const toolbox = createToolbox({
      bank,
      embedder: { name: "stub", dim: 32, embed: async () => stubVec() },
    });

    const { gate, captured } = capturingGate();

    const provider = scriptedProvider([
      [
        {
          type: "tool_call",
          id: "tu_1",
          skill: parent.identity as SkillId,
          args: {},
        },
        { type: "stop", reason: "tool_use" },
      ],
      [{ type: "stop", reason: "end_turn" }],
    ]);

    const sessionId = await sessionStore.create({
      policyPath: "<chain-approval-test>",
      sessionRoot: sessionsRoot,
    });

    await runTurn(
      { provider, toolbox, approval: gate, session: sessionStore, policy: policyObj },
      { sessionId, userMessage: "run the parent" },
    );

    if (captured.length === 0) {
      return {
        name,
        pass: false,
        reasons: ["approval gate never received a PendingAction"],
      };
    }

    const action = captured[0]!;
    const reasons = expect(action);
    return {
      name,
      pass: reasons.length === 0,
      reasons,
      detail: {
        category: action.category,
        derivedFrom: action.derivedFrom,
        skillId: action.skillId,
      },
    };
  } finally {
    await rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessionsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

// ─── case definitions ─────────────────────────────────────────────────────

const case1KnownPrivilegedChainStep = (): Promise<CaseResult> => {
  const child = baseSkill({
    identity: `${PACK}/child-network` as IndexedSkill["identity"],
    id: "child-network",
    title: "Child step that uses network",
    network: ["evil.com"],
  });
  const parent = baseSkill({
    identity: `${PACK}/parent` as IndexedSkill["identity"],
    id: "parent",
    title: "Benign-looking parent with privileged chain",
    chains: [
      { skill: `${PACK}/child-network` },
    ],
  });
  return runCase(
    "case1-known-privileged-chain-step",
    parent,
    [child],
    { requireSigned: false },
    (action) => {
      const reasons: string[] = [];
      // The union [parent (clean) + child (network)] should escalate
      // the category to `explicit` per the capability heuristics.
      if (action.category !== "explicit") {
        reasons.push(`expected category=explicit, got ${action.category}`);
      }
      // The derivedFrom must attribute to the chain step, not just
      // the parent. This is the v0.2.3 fix verified at the wiring
      // layer.
      const hasChainAttribution = action.derivedFrom.some((r) =>
        r.includes("chain:"),
      );
      if (!hasChainAttribution) {
        reasons.push(
          `derivedFrom missing chain:<id> attribution. Got: ${JSON.stringify(action.derivedFrom)}`,
        );
      }
      // Specifically, the child's network capability should be visible.
      const hasNetworkReason = action.derivedFrom.some((r) =>
        r.includes("network"),
      );
      if (!hasNetworkReason) {
        reasons.push(
          `derivedFrom missing network reason. Got: ${JSON.stringify(action.derivedFrom)}`,
        );
      }
      return reasons;
    },
  );
};

const case2UnknownChainStepWorstCase = (): Promise<CaseResult> => {
  const parent = baseSkill({
    identity: `${PACK}/parent` as IndexedSkill["identity"],
    id: "parent",
    title: "Parent with chain step pointing at missing identity",
    chains: [
      // Identity that is NOT in the bank — should trigger
      // synthesizeUnknownChainStep producing worst-case fallback.
      { skill: `${PACK}/missing-typo-identity` },
    ],
  });
  return runCase(
    "case2-unknown-chain-step-worst-case",
    parent,
    [], // no child skill registered → unknown
    { requireSigned: true },
    (action) => {
      const reasons: string[] = [];
      // The synthetic worst-case has signatureStatus: "unsigned".
      // With require_signed: true, the signature gate fires →
      // category "prohibited".
      if (action.category !== "prohibited") {
        reasons.push(
          `expected category=prohibited (worst-case + require_signed), got ${action.category}`,
        );
      }
      return reasons;
    },
  );
};

const case3UnknownChainStepCapabilitiesPath = (): Promise<CaseResult> => {
  // Defense in depth: even with require_signed: false, the synthetic
  // worst-case has network: ["*"], filesystem: ["*"], idempotent:
  // false. The capability heuristics should escalate to explicit.
  // This guards against a hypothetical regression where someone
  // disables require_signed for development and forgets that the
  // unknown-chain-step protection still applies.
  const parent = baseSkill({
    identity: `${PACK}/parent` as IndexedSkill["identity"],
    id: "parent",
    title: "Parent with unknown chain step under --allow-unsigned-equivalent policy",
    chains: [
      { skill: `${PACK}/missing-but-policy-permissive` },
    ],
  });
  return runCase(
    "case3-unknown-chain-step-capabilities-still-escalate",
    parent,
    [],
    { requireSigned: false },
    (action) => {
      const reasons: string[] = [];
      // The worst-case capabilities (network ["*"], filesystem ["*"],
      // non-idempotent) escalate via the heuristics path, not the
      // signature gate. Should be explicit (NOT regular).
      if (action.category === "regular") {
        reasons.push(
          `category fell through to regular — defense in depth broken. Got: ${JSON.stringify(action.derivedFrom)}`,
        );
      }
      if (action.category !== "explicit") {
        reasons.push(
          `expected category=explicit (capability heuristics on worst-case), got ${action.category}`,
        );
      }
      return reasons;
    },
  );
};

// ─── main ─────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  console.log("=".repeat(72));
  console.log("CHAIN-UNION APPROVAL WIRING SMOKE (issue #6, v0.2.3 regression guard)");
  console.log("=".repeat(72));

  const results = await Promise.all([
    case1KnownPrivilegedChainStep(),
    case2UnknownChainStepWorstCase(),
    case3UnknownChainStepCapabilitiesPath(),
  ]);

  let passed = 0;
  for (const r of results) {
    const tag = r.pass ? "✓" : "✗";
    console.log(`\n  [${tag}] ${r.name}`);
    if (r.pass) {
      passed++;
      console.log(
        `       ${JSON.stringify(r.detail)}`,
      );
    } else {
      for (const reason of r.reasons) console.log(`       — ${reason}`);
      if (r.detail) console.log(`       detail: ${JSON.stringify(r.detail)}`);
    }
  }

  console.log("\n" + "─".repeat(72));
  console.log(`pass: ${passed}, fail: ${results.length - passed}`);

  if (passed !== results.length) {
    console.log(
      "\n  REGRESSION DETECTED — chain-union approval wiring is not firing correctly.",
    );
    console.log(
      "  This is the v0.2.3 bypass shape returning. See issue #6 + LESSONS.md doctrine #1.",
    );
    process.exit(1);
  }
};

main().catch((err) => {
  console.error("chain-approval smoke crashed:", err);
  process.exit(2);
});
