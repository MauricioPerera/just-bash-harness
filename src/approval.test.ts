import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  deriveCategory,
  createApprovalGate,
  type DerivedCategory,
} from "./approval.js";
import { synthesizeUnknownChainStep } from "./loop.js";
import type { ApprovalRecord, Policy, ResolvedSkill } from "./types.js";

// ─── fixtures ──────────────────────────────────────────────────────────────

const baseSkill = (overrides: Partial<ResolvedSkill> = {}): ResolvedSkill => ({
  id: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo" as ResolvedSkill["id"],
  shortId: "echo",
  title: "Echo",
  description: "Echoes a message",
  use_when: "the user wants to print",
  pack: "github.com/test/pack",
  version: "1.0.0",
  signatureStatus: "valid",
  network: [],
  filesystem: [],
  idempotent: true,
  args: { msg: { type: "string" } },
  ...overrides,
});

const basePolicy = (overrides: Partial<Policy> = {}): Policy => ({
  version: 1,
  skills: { subscribed: [], overrides: {} },
  signature: { require_signed: true },
  approval: {
    matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
  },
  limits: { maxTurns: 50, maxToolCallsPerTurn: 10, maxWallclockMs: 60_000 },
  paths: { sessionsRoot: "/tmp/test-sessions" },
  ...overrides,
});

// ─── deriveCategory: signature gate ───────────────────────────────────────

test("deriveCategory: signed + safe → regular", () => {
  const r = deriveCategory(baseSkill(), basePolicy());
  assert.equal(r.category, "regular");
  assert.deepEqual(r.derivedFrom, ["default"]);
});

test("deriveCategory: unsigned + require_signed → prohibited", () => {
  const r = deriveCategory(
    baseSkill({ signatureStatus: "unsigned" }),
    basePolicy({ signature: { require_signed: true } }),
  );
  assert.equal(r.category, "prohibited");
  assert.deepEqual(r.derivedFrom, ["signature:unsigned"]);
});

test("deriveCategory: invalid signature + require_signed → prohibited", () => {
  const r = deriveCategory(
    baseSkill({ signatureStatus: "invalid" }),
    basePolicy({ signature: { require_signed: true } }),
  );
  assert.equal(r.category, "prohibited");
  assert.deepEqual(r.derivedFrom, ["signature:invalid"]);
});

test("deriveCategory: unsigned + require_signed:false → falls through to capability checks", () => {
  const r = deriveCategory(
    baseSkill({ signatureStatus: "unsigned", idempotent: true, network: [], filesystem: [] }),
    basePolicy({ signature: { require_signed: false } }),
  );
  assert.equal(r.category, "regular");
});

// ─── deriveCategory: capability heuristics ────────────────────────────────

test("deriveCategory: network non-empty → explicit", () => {
  const r = deriveCategory(
    baseSkill({ network: ["https://api.example.com"] }),
    basePolicy(),
  );
  assert.equal(r.category, "explicit");
  assert.ok(r.derivedFrom.includes("network:1"));
});

test("deriveCategory: filesystem non-empty → explicit", () => {
  const r = deriveCategory(
    baseSkill({ filesystem: ["/etc"] }),
    basePolicy(),
  );
  assert.equal(r.category, "explicit");
  assert.ok(r.derivedFrom.includes("filesystem:1"));
});

test("deriveCategory: idempotent:false → explicit", () => {
  const r = deriveCategory(baseSkill({ idempotent: false }), basePolicy());
  assert.equal(r.category, "explicit");
  assert.deepEqual(r.derivedFrom, ["non-idempotent"]);
});

test("deriveCategory: multiple escalations all recorded", () => {
  const r = deriveCategory(
    baseSkill({
      idempotent: false,
      network: ["https://x", "https://y"],
      filesystem: ["/var"],
    }),
    basePolicy(),
  );
  assert.equal(r.category, "explicit");
  assert.deepEqual(
    r.derivedFrom.sort(),
    ["filesystem:1", "network:2", "non-idempotent"].sort(),
  );
});

// ─── deriveCategory: override map ─────────────────────────────────────────

test("deriveCategory: override by full id wins over derivation", () => {
  const skill = baseSkill({ idempotent: false }); // would derive explicit
  const policy = basePolicy({
    skills: {
      subscribed: [],
      overrides: { [skill.id]: "regular" },
    },
  });
  const r = deriveCategory(skill, policy);
  assert.equal(r.category, "regular");
  assert.deepEqual(r.derivedFrom, ["override:regular"]);
});

test("deriveCategory: override by shortId also works", () => {
  const skill = baseSkill({ idempotent: true });
  const policy = basePolicy({
    skills: { subscribed: [], overrides: { echo: "explicit" } },
  });
  const r = deriveCategory(skill, policy);
  assert.equal(r.category, "explicit");
  assert.deepEqual(r.derivedFrom, ["override:explicit"]);
});

test("deriveCategory: override → prohibited bypasses signature gate", () => {
  const skill = baseSkill({ signatureStatus: "valid" }); // would be regular
  const policy = basePolicy({
    skills: { subscribed: [], overrides: { echo: "prohibited" } },
  });
  const r = deriveCategory(skill, policy);
  assert.equal(r.category, "prohibited");
});

test("deriveCategory: override by full id takes precedence over shortId", () => {
  const skill = baseSkill();
  const policy = basePolicy({
    skills: {
      subscribed: [],
      overrides: {
        [skill.id]: "regular",
        echo: "prohibited",
      },
    },
  });
  const r = deriveCategory(skill, policy);
  assert.equal(r.category, "regular");
});

// ─── createApprovalGate: matrix application ───────────────────────────────

test("createApprovalGate: prohibited is hard-deny regardless of matrix", async () => {
  const policy = basePolicy({
    approval: {
      // even if the matrix says 'allow', prohibited stays denied
      matrix: { prohibited: "allow", explicit: "ask", regular: "allow" } as Policy["approval"]["matrix"],
    },
  });
  const audit: ApprovalRecord[] = [];
  const gate = createApprovalGate({
    policy,
    audit: async (r) => {
      audit.push(r);
    },
  });

  const decision = await gate.check({
    skillId: "any" as ResolvedSkill["id"],
    category: "prohibited",
    args: {},
    rationale: "",
    derivedFrom: [],
  });
  assert.equal(decision, "deny");
});

test("createApprovalGate: matrix lookup for explicit", async () => {
  const policy = basePolicy({
    approval: { matrix: { prohibited: "deny", explicit: "ask", regular: "allow" } },
  });
  const gate = createApprovalGate({ policy, audit: async () => undefined });
  assert.equal(
    await gate.check({
      skillId: "x" as ResolvedSkill["id"],
      category: "explicit",
      args: {},
      rationale: "",
      derivedFrom: [],
    }),
    "ask",
  );
});

test("createApprovalGate: record persists via audit callback", async () => {
  const records: ApprovalRecord[] = [];
  const gate = createApprovalGate({
    policy: basePolicy(),
    audit: async (r) => {
      records.push(r);
    },
  });
  const record: ApprovalRecord = {
    ts: "2026-05-04T00:00:00Z",
    action: {
      skillId: "x" as ResolvedSkill["id"],
      category: "regular",
      args: { msg: "hi" },
      rationale: "test",
      derivedFrom: ["default"],
    },
    decision: "allow",
    source: "policy",
  };
  await gate.record(record);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], record);
});

// Type assertion to make sure DerivedCategory shape stays stable
const _shape: DerivedCategory = { category: "regular", derivedFrom: ["x"] };
void _shape;

// ─── chain-aware derivation (security: closes parent-bypass) ──────────────

test("deriveCategory: chains[] union — child with network escalates a regular-looking parent", () => {
  // Parent looks regular: signed, idempotent, no network. Child has network.
  // Without chain-awareness this auto-allowed; with it, escalates to explicit
  // so the user sees the network capability before approval.
  const parent = baseSkill({ idempotent: true, network: [] });
  const child = baseSkill({
    id: "uploader",
    shortId: "uploader",
    idempotent: true,
    network: ["https://evil.com"],
  });
  const r = deriveCategory(parent, basePolicy(), [child]);
  assert.equal(r.category, "explicit");
  assert.ok(r.derivedFrom.some((s) => s.startsWith("chain:uploader network:")));
});

test("deriveCategory: chains[] union — child non-idempotent escalates idempotent parent", () => {
  const parent = baseSkill({ idempotent: true });
  const child = baseSkill({
    id: "side-effect",
    shortId: "side-effect",
    idempotent: false,
  });
  const r = deriveCategory(parent, basePolicy(), [child]);
  assert.equal(r.category, "explicit");
  assert.ok(r.derivedFrom.includes("chain:side-effect non-idempotent"));
});

test("deriveCategory: chains[] union — child with bad signature → prohibited (signature gate over union)", () => {
  const parent = baseSkill({ signatureStatus: "valid" });
  const child = baseSkill({
    id: "unsigned-child",
    shortId: "unsigned-child",
    signatureStatus: "unsigned",
  });
  const r = deriveCategory(
    parent,
    basePolicy({ signature: { require_signed: true } }),
    [child],
  );
  assert.equal(r.category, "prohibited");
  assert.ok(
    r.derivedFrom.some((s) => s.includes("chain:unsigned-child")),
  );
});

test("deriveCategory: chains[] union — multiple chain steps, all clean → still regular", () => {
  const parent = baseSkill({ idempotent: true });
  const c1 = baseSkill({ id: "a", shortId: "a", idempotent: true });
  const c2 = baseSkill({ id: "b", shortId: "b", idempotent: true });
  const r = deriveCategory(parent, basePolicy(), [c1, c2]);
  assert.equal(r.category, "regular");
});

test("deriveCategory: chains[] union — empty chainSkills behaves identically to old single-skill call", () => {
  // Backwards compat: callers that don't pass chainSkills get the same
  // result as before.
  const skill = baseSkill({ idempotent: false });
  const r1 = deriveCategory(skill, basePolicy());
  const r2 = deriveCategory(skill, basePolicy(), []);
  assert.deepEqual(r1, r2);
});

test("deriveCategory: chains[] union — override on parent still wins (escape hatch preserved)", () => {
  const parent = baseSkill();
  const child = baseSkill({
    id: "danger",
    shortId: "danger",
    network: ["https://x"],
  });
  const policy = basePolicy({
    skills: { subscribed: [], overrides: { [parent.id]: "regular" } },
  });
  const r = deriveCategory(parent, policy, [child]);
  // Override forces regular even though child has network capability —
  // the user has explicitly opted into trusting this whole chain.
  assert.equal(r.category, "regular");
  assert.deepEqual(r.derivedFrom, ["override:regular"]);
});

// ─── unknown chain step worst-case synthesis (fail-closed contract) ───────
//
// When a parent declares chains[] with a step pointing at a skill identity
// that is not in the bank, loop.ts synthesizes a worst-case ResolvedSkill
// for that step before passing it to deriveCategory. These tests guard the
// fail-closed invariant: an unknown chain step MUST resolve to prohibited,
// regardless of policy permissiveness, so a malicious parent cannot smuggle
// a privileged step through by referencing an identity that won't be found.

test("synthesizeUnknownChainStep: applies worst-case capability fields", () => {
  const parent = baseSkill();
  const synthetic = synthesizeUnknownChainStep(parent, "github.com/foo/bar/skills/typo@v1");
  assert.equal(synthetic.id, "github.com/foo/bar/skills/typo@v1");
  assert.equal(synthetic.shortId, "typo@v1");
  assert.equal(synthetic.signatureStatus, "unsigned");
  assert.deepEqual(synthetic.network, ["*"]);
  assert.deepEqual(synthetic.filesystem, ["*"]);
  assert.equal(synthetic.idempotent, false);
});

test("synthesizeUnknownChainStep: shortId falls back to the full id when there is no slash", () => {
  const parent = baseSkill();
  const synthetic = synthesizeUnknownChainStep(parent, "bare-name");
  assert.equal(synthetic.shortId, "bare-name");
});

test("deriveCategory: unknown chain step (signed parent, signed-required policy) → prohibited via signature gate", () => {
  const parent = baseSkill({ signatureStatus: "valid" });
  const synthetic = synthesizeUnknownChainStep(parent, "github.com/x/y/skills/missing");
  const r = deriveCategory(
    parent,
    basePolicy({ signature: { require_signed: true } }),
    [synthetic],
  );
  assert.equal(r.category, "prohibited");
  // Attribution surfaces the chain step's shortId so the user sees what
  // tripped the gate.
  assert.ok(
    r.derivedFrom.some((s) => s.includes("chain:missing") && s.includes("signature:unsigned")),
    `expected chain:missing signature:unsigned in ${JSON.stringify(r.derivedFrom)}`,
  );
});

test("deriveCategory: unknown chain step still escalates when signature gate is off (capability path)", () => {
  // Defense in depth: even if the user disables require_signed (e.g. via
  // --allow-unsigned in development), the synthetic step's network: ["*"]
  // and non-idempotent flags MUST still escalate the union to at least
  // explicit. A naive fix that only relied on the signature gate would
  // leak the unknown step here.
  const parent = baseSkill({ signatureStatus: "valid", network: [], filesystem: [], idempotent: true });
  const synthetic = synthesizeUnknownChainStep(parent, "github.com/x/y/skills/missing");
  const r = deriveCategory(
    parent,
    basePolicy({ signature: { require_signed: false } }),
    [synthetic],
  );
  // Not regular — escalated by the synthetic step's worst-case capabilities.
  assert.notEqual(r.category, "regular");
  assert.equal(r.category, "explicit");
  // All three capability dimensions of the synthetic step should be present
  // in derivedFrom, attributed to the chain.
  const reasons = r.derivedFrom.join(" | ");
  assert.match(reasons, /chain:missing network:1/);
  assert.match(reasons, /chain:missing filesystem:1/);
  assert.match(reasons, /chain:missing non-idempotent/);
});

test("deriveCategory: mixed chain (one known clean step + one unknown) → still prohibited (worst wins)", () => {
  // Regression catch: a chain with an innocent-looking known step in front
  // of an unknown step must not let the unknown one slip through. The
  // signature gate over the union is the dominant rule.
  const parent = baseSkill({ signatureStatus: "valid" });
  const knownClean = baseSkill({
    id: "known-clean",
    shortId: "known-clean",
    signatureStatus: "valid",
    network: [],
    filesystem: [],
    idempotent: true,
  });
  const synthetic = synthesizeUnknownChainStep(parent, "github.com/x/y/skills/missing");
  const r = deriveCategory(
    parent,
    basePolicy({ signature: { require_signed: true } }),
    [knownClean, synthetic],
  );
  assert.equal(r.category, "prohibited");
});
