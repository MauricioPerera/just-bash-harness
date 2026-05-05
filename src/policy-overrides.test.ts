import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyPolicyOverrides } from "./policy-overrides.js";
import { DEFAULT_POLICY } from "./policy.js";
import type { Policy } from "./types.js";

const basePolicy = (): Policy => ({
  ...DEFAULT_POLICY,
  signature: { require_signed: true },
});

test("applyPolicyOverrides: no flags → returns policy unchanged", () => {
  const policy = basePolicy();
  const out = applyPolicyOverrides(policy, new Map());
  assert.equal(out, policy);
  assert.equal(out.signature.require_signed, true);
});

test("applyPolicyOverrides: --allow-unsigned with require_signed=true → flips to false", () => {
  const policy = basePolicy();
  const flags = new Map<string, string | true>([["allow-unsigned", true]]);
  const warnings: string[] = [];
  const out = applyPolicyOverrides(policy, flags, { warn: (l) => warnings.push(l) });
  assert.equal(out.signature.require_signed, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /--allow-unsigned/);
});

test("applyPolicyOverrides: --allow-unsigned but require_signed already false → no-op (no warning)", () => {
  const policy: Policy = { ...basePolicy(), signature: { require_signed: false } };
  const flags = new Map<string, string | true>([["allow-unsigned", true]]);
  const warnings: string[] = [];
  const out = applyPolicyOverrides(policy, flags, { warn: (l) => warnings.push(l) });
  assert.equal(out, policy); // identity preserved
  assert.equal(warnings.length, 0);
});

test("applyPolicyOverrides: --allow-unsigned=stringval (not literal true) → ignored", () => {
  // Defensive: only the literal `true` (no value) flips the bit. A user
  // passing `--allow-unsigned=yes` would parse the next token as the
  // value and the gate would NOT be dropped.
  const policy = basePolicy();
  const flags = new Map<string, string | true>([["allow-unsigned", "yes"]]);
  const out = applyPolicyOverrides(policy, flags);
  assert.equal(out.signature.require_signed, true);
});

test("applyPolicyOverrides: returns NEW policy object (no mutation)", () => {
  const policy = basePolicy();
  const flags = new Map<string, string | true>([["allow-unsigned", true]]);
  const out = applyPolicyOverrides(policy, flags);
  assert.notEqual(out, policy);
  assert.notEqual(out.signature, policy.signature);
  // Original untouched
  assert.equal(policy.signature.require_signed, true);
});
