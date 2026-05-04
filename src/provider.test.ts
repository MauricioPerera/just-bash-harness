import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveProviderFromEnv } from "./provider.js";

test("resolveProviderFromEnv: prefers cloudflare in auto-detect when both creds present", () => {
  const r = resolveProviderFromEnv({
    env: {
      CF_ACCOUNT_ID: "acct",
      CF_API_TOKEN: "tok",
      ANTHROPIC_API_KEY: "k",
    },
  });
  assert.equal(r.choice, "cloudflare");
  assert.equal(r.model, "@cf/google/gemma-4-26b-a4b-it");
});

test("resolveProviderFromEnv: HARNESS_PROVIDER=anthropic overrides auto-detect", () => {
  const r = resolveProviderFromEnv({
    env: {
      HARNESS_PROVIDER: "anthropic",
      CF_ACCOUNT_ID: "acct",
      CF_API_TOKEN: "tok",
      ANTHROPIC_API_KEY: "k",
    },
  });
  assert.equal(r.choice, "anthropic");
});

test("resolveProviderFromEnv: HARNESS_PROVIDER=cloudflare overrides auto-detect", () => {
  const r = resolveProviderFromEnv({
    env: {
      HARNESS_PROVIDER: "cloudflare",
      CF_ACCOUNT_ID: "acct",
      CF_API_TOKEN: "tok",
      ANTHROPIC_API_KEY: "k",
    },
  });
  assert.equal(r.choice, "cloudflare");
});

test("resolveProviderFromEnv: only ANTHROPIC_API_KEY → anthropic", () => {
  const r = resolveProviderFromEnv({ env: { ANTHROPIC_API_KEY: "k" } });
  assert.equal(r.choice, "anthropic");
  assert.equal(r.model, "claude-opus-4-7");
});

test("resolveProviderFromEnv: only CF creds → cloudflare", () => {
  const r = resolveProviderFromEnv({
    env: { CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok" },
  });
  assert.equal(r.choice, "cloudflare");
});

test("resolveProviderFromEnv: opts.force=cloudflare without creds throws", () => {
  assert.throws(
    () => resolveProviderFromEnv({ force: "cloudflare", env: {} }),
    /CF_ACCOUNT_ID and CF_API_TOKEN/,
  );
});

test("resolveProviderFromEnv: opts.force=anthropic without creds throws", () => {
  assert.throws(
    () => resolveProviderFromEnv({ force: "anthropic", env: {} }),
    /ANTHROPIC_API_KEY/,
  );
});

test("resolveProviderFromEnv: no creds → throws with both options listed", () => {
  assert.throws(
    () => resolveProviderFromEnv({ env: {} }),
    /no LLM provider configured/,
  );
});

test("resolveProviderFromEnv: opts.model overrides default for cloudflare", () => {
  const r = resolveProviderFromEnv({
    model: "@cf/meta/llama-3.1-8b-instruct",
    env: { CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok" },
  });
  assert.equal(r.model, "@cf/meta/llama-3.1-8b-instruct");
});

test("resolveProviderFromEnv: CF_LLM_MODEL env var overrides cloudflare default", () => {
  const r = resolveProviderFromEnv({
    env: {
      CF_ACCOUNT_ID: "acct",
      CF_API_TOKEN: "tok",
      CF_LLM_MODEL: "@cf/some/other-model",
    },
  });
  assert.equal(r.model, "@cf/some/other-model");
});

test("resolveProviderFromEnv: HARNESS_DEFAULT_MODEL overrides anthropic default", () => {
  const r = resolveProviderFromEnv({
    env: {
      ANTHROPIC_API_KEY: "k",
      HARNESS_DEFAULT_MODEL: "claude-sonnet-4-6",
    },
  });
  assert.equal(r.model, "claude-sonnet-4-6");
});

test("resolveProviderFromEnv: opts.model takes precedence over CF_LLM_MODEL", () => {
  const r = resolveProviderFromEnv({
    model: "explicit-flag-model",
    env: {
      CF_ACCOUNT_ID: "acct",
      CF_API_TOKEN: "tok",
      CF_LLM_MODEL: "env-model",
    },
  });
  assert.equal(r.model, "explicit-flag-model");
});
