import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  suggestOverrides,
  renderSuggestionsYaml,
  renderSkippedSection,
  matchDestructivePattern,
  DESTRUCTIVE_SKILL_PATTERNS,
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
  assert.equal(suggestOverrides(stats, { minAsks: 5 }).suggestions.length, 0);
});

test("suggestOverrides: high allow-ratio + above minAsks → suggested as 'regular'", () => {
  const stats = [stat({ ask_count: 10, allow_count: 10 })];
  const out = suggestOverrides(stats, { minAsks: 5, minAllowRatio: 0.95 });
  assert.equal(out.suggestions.length, 1);
  assert.equal(out.suggestions[0]?.suggested, "regular");
  assert.equal(out.suggestions[0]?.ratio, 1);
  assert.equal(out.skipped.length, 0);
});

test("suggestOverrides: any historical deny disqualifies", () => {
  const stats = [stat({ ask_count: 20, allow_count: 19, deny_count: 1 })];
  assert.equal(suggestOverrides(stats).suggestions.length, 0);
});

test("suggestOverrides: last_decision=deny disqualifies even with clean history", () => {
  // Edge case: last record was a deny — likely a deliberate user
  // signal that this skill is no longer auto-trusted.
  const stats = [
    stat({ ask_count: 50, allow_count: 50, deny_count: 0, last_decision: "deny" }),
  ];
  assert.equal(suggestOverrides(stats).suggestions.length, 0);
});

test("suggestOverrides: ratio below threshold → not suggested", () => {
  const stats = [stat({ ask_count: 10, allow_count: 8 })]; // 0.8 < 0.95
  assert.equal(
    suggestOverrides(stats, { minAllowRatio: 0.95 }).suggestions.length,
    0,
  );
});

test("suggestOverrides: results sorted by ask_count desc", () => {
  const a = stat({ skillId: "id-A" as SkillId, ask_count: 8, allow_count: 8 });
  const b = stat({ skillId: "id-B" as SkillId, ask_count: 20, allow_count: 20 });
  const c = stat({ skillId: "id-C" as SkillId, ask_count: 12, allow_count: 12 });
  const out = suggestOverrides([a, b, c], { minAsks: 5 });
  assert.deepEqual(
    out.suggestions.map((s) => s.skillId),
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

// ─── destructive-pattern blacklist (Phase 1, Option 1) ─────────────────────
//
// Phase 1 decision recorded 2026-05-06 in CONTRACT-suggester-blacklist.md:
// destructive skill IDs are NEVER suggested for promotion regardless of
// allow-ratio. The pattern set below is the user-visible deliverable; if it
// changes, DESIGN §3.3 must move in lockstep (LESSONS doctrine #6).

test("matchDestructivePattern: delete-workflow matches", () => {
  const m = matchDestructivePattern("github.com/foo/pack/delete-workflow" as SkillId);
  assert.notEqual(m, null);
});

test("matchDestructivePattern: truncate-table matches", () => {
  const m = matchDestructivePattern("github.com/foo/db/truncate-table" as SkillId);
  assert.notEqual(m, null);
});

test("matchDestructivePattern: case-insensitive (DELETE-Foo matches)", () => {
  const m = matchDestructivePattern("github.com/foo/DELETE-Foo" as SkillId);
  assert.notEqual(m, null);
});

test("matchDestructivePattern: batch-deactivate (tail-anchored) matches", () => {
  const m = matchDestructivePattern("github.com/foo/users/batch-deactivate" as SkillId);
  assert.notEqual(m, null);
});

test("matchDestructivePattern: undelete-cache does NOT match (preceded by letter)", () => {
  // The (^|[/-]) anchor prevents `undelete-` from matching `delete-`.
  // This is the core false-positive guard for Phase 1.
  const m = matchDestructivePattern("github.com/foo/cache/undelete-cache" as SkillId);
  assert.equal(m, null);
});

test("matchDestructivePattern: disk-usage does NOT match", () => {
  const m = matchDestructivePattern("github.com/foo/system/disk-usage" as SkillId);
  assert.equal(m, null);
});

test("matchDestructivePattern: pg-vacuum does NOT match", () => {
  // pg-vacuum is idempotent: false but not destructive. The contract's
  // Option 2 rejection rationale: heuristics on idempotency are too noisy.
  // Phase 1 patterns must let pg-vacuum through.
  const m = matchDestructivePattern("github.com/foo/postgres/pg-vacuum" as SkillId);
  assert.equal(m, null);
});

test("DESTRUCTIVE_SKILL_PATTERNS: pattern list is non-empty (sanity)", () => {
  assert.ok(DESTRUCTIVE_SKILL_PATTERNS.length >= 10);
});

test("suggestOverrides: destructive skill at 100/100 → NOT in suggestions, IS in skipped", () => {
  const stats = [
    stat({
      skillId: "github.com/foo/pack/delete-workflow" as SkillId,
      ask_count: 100,
      allow_count: 100,
    }),
  ];
  const out = suggestOverrides(stats, { minAsks: 5 });
  assert.equal(out.suggestions.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0]?.reason, "destructive");
  assert.match(out.skipped[0]?.matchedPattern ?? "", /delete-/);
});

test("suggestOverrides: destructive skill below minAsks → not in skipped either", () => {
  // Skipped list is for skills that PASSED ratio/asks gates but were
  // filtered as destructive. A skill that didn't reach the threshold
  // wouldn't have been suggested anyway, so we don't add noise.
  const stats = [
    stat({
      skillId: "github.com/foo/pack/delete-workflow" as SkillId,
      ask_count: 2,
      allow_count: 2,
    }),
  ];
  const out = suggestOverrides(stats, { minAsks: 5 });
  assert.equal(out.suggestions.length, 0);
  assert.equal(out.skipped.length, 0);
});

test("suggestOverrides: mixed list — destructive in skipped, benign in suggestions", () => {
  const stats = [
    stat({
      skillId: "github.com/foo/pack/delete-workflow" as SkillId,
      ask_count: 50,
      allow_count: 50,
    }),
    stat({
      skillId: "github.com/foo/pack/disk-usage" as SkillId,
      ask_count: 30,
      allow_count: 30,
    }),
    stat({
      skillId: "github.com/foo/pack/truncate-table" as SkillId,
      ask_count: 80,
      allow_count: 80,
    }),
  ];
  const out = suggestOverrides(stats, { minAsks: 5 });
  assert.equal(out.suggestions.length, 1);
  assert.equal(out.suggestions[0]?.skillId, "github.com/foo/pack/disk-usage");
  assert.equal(out.skipped.length, 2);
  // Sorted by ask_count desc: truncate-table (80) before delete-workflow (50).
  assert.equal(out.skipped[0]?.skillId, "github.com/foo/pack/truncate-table");
  assert.equal(out.skipped[1]?.skillId, "github.com/foo/pack/delete-workflow");
});

test("renderSkippedSection: empty list → empty string (caller can concatenate)", () => {
  assert.equal(renderSkippedSection([]), "");
});

test("renderSkippedSection: shows skill, ratio, and matching pattern", () => {
  const out = renderSkippedSection([
    {
      skillId: "github.com/foo/pack/delete-workflow" as SkillId,
      ask_count: 50,
      allow_count: 50,
      deny_count: 0,
      ratio: 1,
      reason: "destructive",
      matchedPattern: "(^|[/-])delete-",
    },
  ]);
  assert.match(out, /skipped: 1 skill/);
  assert.match(out, /destructive/);
  assert.match(out, /github\.com\/foo\/pack\/delete-workflow/);
  assert.match(out, /asks=50/);
  assert.match(out, /pattern=/);
});
