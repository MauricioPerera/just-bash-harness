import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectEncryptionError,
  wrapEncryptionError,
} from "./util-encryption-error.js";

// ─── detectEncryptionError ─────────────────────────────────────────────────
//
// Doctrine: bias the heuristic toward FALSE NEGATIVES. We'd rather miss
// a real key mismatch (and show the raw error) than mistakenly tell a
// user their HARNESS_ENCRYPTION_KEY is wrong when something else broke.
// Every test case below fixes one boundary of that trade-off.

test("detectEncryptionError: 'unable to authenticate data' → true", () => {
  // Verbatim phrase observed from just-bash-data with wrong key. This is
  // the primary signal — Node's crypto module surfaces it on AES-GCM
  // tag mismatch.
  const err = new Error("Unsupported state or unable to authenticate data");
  assert.equal(detectEncryptionError(err), true);
});

test("detectEncryptionError: 'authentication tag' phrase → true", () => {
  const err = new Error("Decryption failed: invalid authentication tag");
  assert.equal(detectEncryptionError(err), true);
});

test("detectEncryptionError: 'bad decrypt' (legacy OpenSSL) → true", () => {
  const err = new Error("EVP_DecryptFinal_ex: bad decrypt");
  assert.equal(detectEncryptionError(err), true);
});

test("detectEncryptionError: 'decrypt' + non-zero exit code in stderr → true", () => {
  // just-bash-data wraps the bash error; the cryptographic detail
  // sometimes lives in `.stderr` rather than `.message`.
  const err = new Error("db sessions find: command failed") as Error & {
    stderr: string;
  };
  err.stderr = "decrypt failed\nexit code: 3";
  assert.equal(detectEncryptionError(err), true);
});

test("detectEncryptionError: ENOENT (typical missing-file) → false", () => {
  const err = new Error("ENOENT: no such file or directory, open '/foo'");
  assert.equal(detectEncryptionError(err), false);
});

test("detectEncryptionError: 'permission denied' → false", () => {
  const err = new Error("EACCES: permission denied");
  assert.equal(detectEncryptionError(err), false);
});

test("detectEncryptionError: 'session not found' (typo'd id) → false", () => {
  // Critical false-positive guard: the most common non-encryption error
  // a user hits is a typo'd session id. We must not wrap it.
  const err = new Error("session not found: s_abc123");
  assert.equal(detectEncryptionError(err), false);
});

test("detectEncryptionError: bare 'decrypt' without exit-code signal → false", () => {
  // Conservative: a generic "decryption" mention without a signal that
  // it actually failed (exit code) is too weak to wrap. Could be docs,
  // could be an unrelated module name.
  const err = new Error("This skill uses decrypt() internally.");
  assert.equal(detectEncryptionError(err), false);
});

test("detectEncryptionError: null / undefined / non-Error values → false", () => {
  assert.equal(detectEncryptionError(null), false);
  assert.equal(detectEncryptionError(undefined), false);
  assert.equal(detectEncryptionError(42), false);
  assert.equal(detectEncryptionError(""), false);
});

test("detectEncryptionError: error chain via .cause is inspected", () => {
  // Sometimes the real cryptographic error is wrapped by an outer
  // adapter error; we should follow .cause one level.
  const inner = new Error("unable to authenticate data");
  const outer = new Error("session load failed") as Error & { cause: Error };
  outer.cause = inner;
  assert.equal(detectEncryptionError(outer), true);
});

test("detectEncryptionError: case-insensitive match", () => {
  const err = new Error("UNABLE TO AUTHENTICATE DATA");
  assert.equal(detectEncryptionError(err), true);
});

// ─── wrapEncryptionError ───────────────────────────────────────────────────

test("wrapEncryptionError: message names HARNESS_ENCRYPTION_KEY", () => {
  const wrapped = wrapEncryptionError(
    new Error("unable to authenticate data"),
    "harness audit",
  );
  assert.match(wrapped.message, /HARNESS_ENCRYPTION_KEY/);
});

test("wrapEncryptionError: message mentions `harness rekey`", () => {
  const wrapped = wrapEncryptionError(
    new Error("unable to authenticate data"),
    "harness audit",
  );
  assert.match(wrapped.message, /harness rekey/);
});

test("wrapEncryptionError: includes context label so user knows the source command", () => {
  const wrapped = wrapEncryptionError(
    new Error("unable to authenticate data"),
    "harness memory list",
  );
  assert.match(wrapped.message, /harness memory list/);
});

test("wrapEncryptionError: original error is preserved as .cause", () => {
  const original = new Error("unable to authenticate data");
  const wrapped = wrapEncryptionError(original, "harness audit");
  assert.equal((wrapped as Error & { cause?: Error }).cause, original);
});

test("wrapEncryptionError: original message is included (truncated)", () => {
  const original = new Error("unable to authenticate data");
  const wrapped = wrapEncryptionError(original, "harness audit");
  assert.match(wrapped.message, /unable to authenticate data/);
});

test("wrapEncryptionError: long original message is truncated to 200 chars", () => {
  const long = "x".repeat(500);
  const wrapped = wrapEncryptionError(new Error(long), "harness audit");
  // The truncation marker is "…"; the 200-char prefix should appear, but
  // the full 500-char string should NOT.
  assert.equal(wrapped.message.includes("x".repeat(200)), true);
  assert.equal(wrapped.message.includes("x".repeat(500)), false);
  assert.match(wrapped.message, /…/);
});

test("wrapEncryptionError: handles non-Error thrown values", () => {
  // Defensive: code throwing a string or null shouldn't crash the wrapper.
  const wrappedString = wrapEncryptionError("raw string error", "harness audit");
  assert.match(wrappedString.message, /HARNESS_ENCRYPTION_KEY/);
  assert.match(wrappedString.message, /raw string error/);

  const wrappedNull = wrapEncryptionError(null, "harness audit");
  assert.match(wrappedNull.message, /HARNESS_ENCRYPTION_KEY/);
});

test("wrapEncryptionError: message does NOT contain the env var's value", () => {
  // Constraint: never echo any portion of the key. Even if the original
  // error somehow included the key (it shouldn't, but defense-in-depth),
  // we test that the wrapper's NEW prose doesn't fabricate one. This is
  // a structural test — the wrapper's lines never reference any value.
  const wrapped = wrapEncryptionError(
    new Error("unable to authenticate data"),
    "harness audit",
  );
  // The wrapper text mentions HARNESS_ENCRYPTION_KEY as a name but should
  // not assign a value to it.
  assert.equal(/HARNESS_ENCRYPTION_KEY\s*=\s*\S/i.test(wrapped.message), false);
});
