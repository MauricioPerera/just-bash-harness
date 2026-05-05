import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileBank,
  type EmbeddingProvider,
  type HostContext,
  type IndexedSkill,
} from "@rckflr/agent-skills-cli";

import { createToolbox } from "./toolbox.js";

// ─── fixtures ──────────────────────────────────────────────────────────────

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const stubEmbedder: EmbeddingProvider = {
  name: "stub",
  dim: 32,
  embed: async () => stubVec(),
};

const baseSkill = (overrides: Partial<IndexedSkill>): IndexedSkill => ({
  identity:
    "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/skill",
  schema_version: "0.1",
  id: "skill",
  version: "1.0.0",
  title: "Skill",
  description: "...",
  use_when: "...",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
  idempotent: true,
  provenance: {
    source_type: "git",
    source: "github.com/test/pack",
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

const linuxHost: HostContext = {
  os: "linux",
  arch: "x86_64",
  envKeys: new Set(["HOME", "PATH", "EXISTING_VAR"]),
  shellCommandsAvailable: new Set(["bash", "curl", "jq"]),
};

const macHost: HostContext = {
  os: "macos",
  arch: "arm64",
  envKeys: new Set(["HOME", "PATH"]),
  shellCommandsAvailable: new Set(["bash", "curl"]),
};

const buildBankWith = async (skills: IndexedSkill[]): Promise<{
  bank: FileBank;
  cleanup: () => Promise<void>;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "toolbox-test-"));
  const bank = new FileBank({ rootDir: dir });
  await bank.initMeta({ embedding_model: "stub:fnv1a-32", embedding_dim: 32 });
  for (const s of skills) await bank.upsertSkill(s);
  return {
    bank,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
};

// ─── filter: OS ────────────────────────────────────────────────────────────

test("toolbox.list: skill with applicable_when.os matching host included", async () => {
  const skill = baseSkill({
    identity:
      "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/linux-only",
    id: "linux-only",
    applicable_when: { os: ["linux"] },
  });
  const { bank, cleanup } = await buildBankWith([skill]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: linuxHost,
    });
    const tools = await tbx.list();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.shortId, "linux-only");
  } finally {
    await cleanup();
  }
});

test("toolbox.list: skill with applicable_when.os mismatching host filtered out", async () => {
  const linuxOnly = baseSkill({
    identity:
      "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/linux-only",
    id: "linux-only",
    applicable_when: { os: ["linux"] },
  });
  const { bank, cleanup } = await buildBankWith([linuxOnly]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: macHost, // wrong OS
    });
    const tools = await tbx.list();
    assert.equal(tools.length, 0, `expected linux-only to be filtered on macOS host`);
  } finally {
    await cleanup();
  }
});

// ─── filter: shell commands ────────────────────────────────────────────────

test("toolbox.list: skill requiring a present command included", async () => {
  const skill = baseSkill({
    identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/curl-using",
    id: "curl-using",
    applicable_when: { shell_commands_present: ["curl"] },
  });
  const { bank, cleanup } = await buildBankWith([skill]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: linuxHost, // has curl
    });
    const tools = await tbx.list();
    assert.equal(tools.length, 1);
  } finally {
    await cleanup();
  }
});

test("toolbox.list: skill requiring a missing command filtered out", async () => {
  const skill = baseSkill({
    identity:
      "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/needs-rg",
    id: "needs-rg",
    applicable_when: { shell_commands_present: ["rg"] }, // not in linuxHost
  });
  const { bank, cleanup } = await buildBankWith([skill]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: linuxHost,
    });
    const tools = await tbx.list();
    assert.equal(tools.length, 0);
  } finally {
    await cleanup();
  }
});

// ─── filter: env vars ──────────────────────────────────────────────────────

test("toolbox.list: skill requiring a present env var included", async () => {
  const skill = baseSkill({
    identity:
      "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/needs-env",
    id: "needs-env",
    applicable_when: { env_present: ["EXISTING_VAR"] },
  });
  const { bank, cleanup } = await buildBankWith([skill]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: linuxHost,
    });
    const tools = await tbx.list();
    assert.equal(tools.length, 1);
  } finally {
    await cleanup();
  }
});

test("toolbox.list: skill requiring an absent env var filtered out", async () => {
  const skill = baseSkill({
    identity:
      "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/needs-missing",
    id: "needs-missing",
    applicable_when: { env_present: ["NEVER_SET_BY_TEST"] },
  });
  const { bank, cleanup } = await buildBankWith([skill]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: linuxHost,
    });
    const tools = await tbx.list();
    assert.equal(tools.length, 0);
  } finally {
    await cleanup();
  }
});

// ─── unconstrained skills always pass ──────────────────────────────────────

test("toolbox.list: skill without applicable_when always passes filter", async () => {
  const skill = baseSkill({ id: "no-constraints" });
  const { bank, cleanup } = await buildBankWith([skill]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: linuxHost,
    });
    const tools = await tbx.list();
    assert.equal(tools.length, 1);
  } finally {
    await cleanup();
  }
});

// ─── filter disabled ───────────────────────────────────────────────────────

test("toolbox.list: filterApplicable=false returns ALL skills regardless of host fitness", async () => {
  const linuxOnly = baseSkill({
    identity:
      "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/linux-only",
    id: "linux-only",
    applicable_when: { os: ["linux"] },
  });
  const needsRg = baseSkill({
    identity:
      "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/needs-rg",
    id: "needs-rg",
    applicable_when: { shell_commands_present: ["rg"] },
  });
  const { bank, cleanup } = await buildBankWith([linuxOnly, needsRg]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: macHost, // would normally filter both
      filterApplicable: false,
    });
    const tools = await tbx.list();
    assert.equal(tools.length, 2, "filter disabled — both should pass");
  } finally {
    await cleanup();
  }
});

// ─── mixed: some pass, some don't ──────────────────────────────────────────

test("toolbox.list: mixed catalog — only applicable skills returned", async () => {
  const ok1 = baseSkill({
    identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/ok-1",
    id: "ok-1",
    // no applicable_when → always ok
  });
  const ok2 = baseSkill({
    identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/ok-2",
    id: "ok-2",
    applicable_when: { os: ["linux", "macos"] },
  });
  const fail1 = baseSkill({
    identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/fail-1",
    id: "fail-1",
    applicable_when: { shell_commands_present: ["never-installed"] },
  });
  const fail2 = baseSkill({
    identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/fail-2",
    id: "fail-2",
    applicable_when: { os: ["windows"] },
  });
  const { bank, cleanup } = await buildBankWith([ok1, ok2, fail1, fail2]);
  try {
    const tbx = createToolbox({
      bank,
      embedder: stubEmbedder,
      hostContext: linuxHost,
    });
    const tools = await tbx.list();
    const ids = tools.map((t) => t.shortId).sort();
    assert.deepEqual(ids, ["ok-1", "ok-2"]);
  } finally {
    await cleanup();
  }
});
