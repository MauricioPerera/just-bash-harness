import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  deriveCategory,
  createApprovalGate,
  type DerivedCategory,
} from "./approval.js";
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
