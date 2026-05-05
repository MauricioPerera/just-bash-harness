import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  scrubSecrets,
  scrubToolResult,
  DEFAULT_PATTERNS,
} from "./redact.js";

test("scrubSecrets: empty input → no-op", () => {
  const out = scrubSecrets("");
  assert.equal(out.scrubbed, "");
  assert.equal(out.matched, 0);
});

test("scrubSecrets: AWS access key id replaced with marker", () => {
  const input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
  const out = scrubSecrets(input);
  assert.equal(out.matched, 1);
  assert.equal(out.byKind["aws-access-key"], 1);
  assert.match(out.scrubbed, /\[REDACTED:aws-access-key:20\]/);
  assert.ok(!out.scrubbed.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("scrubSecrets: GitHub token (ghp_) replaced", () => {
  const input = "export GH_TOKEN=ghp_1234567890abcdefABCDEF1234567890abcd";
  const out = scrubSecrets(input);
  assert.equal(out.byKind["github-token"], 1);
  assert.ok(!out.scrubbed.includes("ghp_1234567890abcdefABCDEF1234567890abcd"));
});

test("scrubSecrets: github_pat_ replaced", () => {
  const input = "github_pat_" + "a".repeat(82);
  const out = scrubSecrets(input);
  assert.equal(out.byKind["github-pat"], 1);
});

test("scrubSecrets: Slack xoxb token replaced", () => {
  // Synthetic fixture, NOT a real-looking Slack token (avoids triggering
  // GitHub's secret scanner on push). Long enough to clear the 20-char
  // floor in our pattern.
  const fakeToken = "xoxb-" + "AAAAAAAAAAAAAAAAAAAAA";
  const out = scrubSecrets(fakeToken);
  assert.equal(out.byKind["slack-token"], 1);
});

test("scrubSecrets: JWT shape replaced", () => {
  // 8+ chars in each segment to clear the floor.
  const input =
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWJqZWN0IjoidGVzdCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const out = scrubSecrets(input);
  assert.equal(out.byKind["jwt"], 1);
  assert.ok(!out.scrubbed.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"));
});

test("scrubSecrets: PEM private key block (multiline)", () => {
  const input = `before
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDNxYz...
-----END PRIVATE KEY-----
after`;
  const out = scrubSecrets(input);
  assert.equal(out.byKind["pem-private-key"], 1);
  assert.match(out.scrubbed, /\[REDACTED:pem-private-key:\d+\]/);
  assert.ok(out.scrubbed.includes("before"));
  assert.ok(out.scrubbed.includes("after"));
});

test("scrubSecrets: multiple distinct secrets in one input", () => {
  const input = `AKIAIOSFODNN7EXAMPLE and ghp_${"a".repeat(40)}`;
  const out = scrubSecrets(input);
  assert.equal(out.matched, 2);
  assert.equal(out.byKind["aws-access-key"], 1);
  assert.equal(out.byKind["github-token"], 1);
});

test("scrubSecrets: no secrets → byKind empty, scrubbed equals input", () => {
  const input = "the quick brown fox 1234 abc-def-ghi";
  const out = scrubSecrets(input);
  assert.equal(out.scrubbed, input);
  assert.equal(out.matched, 0);
  assert.deepEqual(out.byKind, {});
});

test("scrubSecrets: false-positive resistance — UUID NOT clipped", () => {
  // Phase 1 deliberately doesn't match generic high-entropy strings.
  const input = "request-id: 550e8400-e29b-41d4-a716-446655440000";
  const out = scrubSecrets(input);
  assert.equal(out.matched, 0);
  assert.equal(out.scrubbed, input);
});

test("scrubSecrets: false-positive resistance — env-style PASSWORD assignment NOT clipped", () => {
  // Phase 1: env-style assignments are intentionally not scrubbed
  // (would clip docs/templates). Phase 2 with policy config will.
  const input = "DATABASE_PASSWORD=hunter2";
  const out = scrubSecrets(input);
  assert.equal(out.matched, 0);
});

test("scrubToolResult: scrubs both stdout and stderr, returns redacted count", () => {
  const result = {
    ok: true,
    command: "test",
    stdout: "key=AKIAIOSFODNN7EXAMPLE",
    stderr: "warn: ghp_" + "a".repeat(40),
    exitCode: 0,
    elapsedMs: 0,
    timedOut: false,
  };
  const out = scrubToolResult(result);
  assert.equal(out.redacted, 2);
  assert.ok(!out.stdout.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!out.stderr.includes("ghp_"));
  // Original untouched.
  assert.ok(result.stdout.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("scrubToolResult: clean output → redacted=0, fields preserved", () => {
  const result = {
    ok: true,
    command: "echo hi",
    stdout: "hi\n",
    stderr: "",
    exitCode: 0,
    elapsedMs: 12,
    timedOut: false,
  };
  const out = scrubToolResult(result);
  assert.equal(out.redacted, 0);
  assert.equal(out.stdout, "hi\n");
  assert.equal(out.stderr, "");
  // Other fields preserved.
  assert.equal(out.exitCode, 0);
  assert.equal(out.elapsedMs, 12);
});

test("scrubSecrets: caller can pass custom pattern list", () => {
  const custom = [
    { kind: "test-secret", pattern: /SECRET-[A-Z]{4}/g },
  ];
  const out = scrubSecrets("found SECRET-ABCD here", custom);
  assert.equal(out.byKind["test-secret"], 1);
  // Default patterns NOT applied with explicit override.
  const out2 = scrubSecrets("AKIAIOSFODNN7EXAMPLE", custom);
  assert.equal(out2.matched, 0);
});

test("DEFAULT_PATTERNS: every regex has /g flag (replaceAll requirement)", () => {
  for (const p of DEFAULT_PATTERNS) {
    assert.ok(p.pattern.global, `${p.kind} pattern is missing /g flag`);
  }
});
