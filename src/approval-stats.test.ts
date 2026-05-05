import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  suggestOverrides,
  renderSuggestionsYaml,
  type ApprovalStat,
} from "./approval-stats.js";
import type { SkillId } from "./types.js";

const stat = (overrides: Partial<ApprovalStat>): ApprovalStat => ({
  skillId: "github.com/test/pack/echo" as SkillId,
  ask_count: 0,
  allow_count: 0,
  deny_count: 0,
  last_ts: "2026-05-05T00:00:00Z",
  last_decision: "allow",
  ...overrides,
});

test("suggestOverrides: skill below minAsks → not suggested", () => {
  const stats = [stat({ ask_count: 3, allow_count: 3 })];
  assert.equal(suggestOverrides(stats, { minAsks: 5 }).length, 0);
});

test("suggestOverrides: high allow-ratio + above minAsks → suggested as 'regular'", () => {
  const stats = [stat({ ask_count: 10, allow_count: 10 })];
  const out = suggestOverrides(stats, { minAsks: 5, minAllowRatio: 0.95 });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.suggested, "regular");
  assert.equal(out[0]?.ratio, 1);
});

test("suggestOverrides: any historical deny disqualifies", () => {
  const stats = [stat({ ask_count: 20, allow_count: 19, deny_count: 1 })];
  assert.equal(suggestOverrides(stats).length, 0);
});

test("suggestOverrides: last_decision=deny disqualifies even with clean history", () => {
  // Edge case: last record was a deny — likely a deliberate user
  // signal that this skill is no longer auto-trusted.
  const stats = [
    stat({ ask_count: 50, allow_count: 50, deny_count: 0, last_decision: "deny" }),
  ];
  assert.equal(suggestOverrides(stats).length, 0);
});

test("suggestOverrides: ratio below threshold → not suggested", () => {
  const stats = [stat({ ask_count: 10, allow_count: 8 })]; // 0.8 < 0.95
  assert.equal(suggestOverrides(stats, { minAllowRatio: 0.95 }).length, 0);
});

test("suggestOverrides: results sorted by ask_count desc", () => {
  const a = stat({ skillId: "id-A" as SkillId, ask_count: 8, allow_count: 8 });
  const b = stat({ skillId: "id-B" as SkillId, ask_count: 20, allow_count: 20 });
  const c = stat({ skillId: "id-C" as SkillId, ask_count: 12, allow_count: 12 });
  const out = suggestOverrides([a, b, c], { minAsks: 5 });
  assert.deepEqual(
    out.map((s) => s.skillId),
    ["id-B", "id-C", "id-A"],
  );
});

test("renderSuggestionsYaml: empty list → comment", () => {
  const yaml = renderSuggestionsYaml([]);
  assert.match(yaml, /no suggestions/);
});

test("renderSuggestionsYaml: paste-ready overrides block", () => {
  const yaml = renderSuggestionsYaml([
    {
      skillId: "github.com/foo/echo" as SkillId,
      ask_count: 12,
      allow_count: 12,
      deny_count: 0,
      ratio: 1,
      suggested: "regular",
    },
  ]);
  assert.match(yaml, /^skills:/m);
  assert.match(yaml, /overrides:/);
  assert.match(yaml, /"github\.com\/foo\/echo": regular/);
  assert.match(yaml, /asks=12/);
  assert.match(yaml, /ratio=1\.00/);
});
