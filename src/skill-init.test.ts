import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileBank, type EmbeddingProvider } from "@rckflr/agent-skills-cli";

import { runSkillInit } from "./skill-init.js";

// ─── fixtures ─────────────────────────────────────────────────────────────
//
// Same shape as memory.test.ts: real filesystem under mkdtemp, real
// FileBank, toy embedder. We exercise the actual runInit + upsertSkill
// integration; mocking those would defeat the purpose since the contract
// is precisely about wiring them together correctly.

const toyEmbedder = (dim = 16): EmbeddingProvider => ({
  name: "toy",
  dim,
  async embed(text) {
    const v = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[i % dim]! += (text.charCodeAt(i) % 17) / 17;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  },
});

interface Fixture {
  scaffoldDir: string;
  bankDir: string;
  bank: FileBank;
  embedder: EmbeddingProvider;
  cleanup: () => Promise<void>;
}

const setup = async (): Promise<Fixture> => {
  const scaffoldDir = await mkdtemp(join(tmpdir(), "skill-init-scaffold-"));
  const bankDir = await mkdtemp(join(tmpdir(), "skill-init-bank-"));
  const embedder = toyEmbedder();
  const bank = new FileBank({ rootDir: bankDir });
  await bank.ensureDir();
  await bank.initMeta({
    embedding_model: embedder.name,
    embedding_dim: embedder.dim,
  });
  return {
    scaffoldDir,
    bankDir,
    bank,
    embedder,
    cleanup: async () => {
      await rm(scaffoldDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(bankDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
};

// ─── happy path: scaffold + subscribe ─────────────────────────────────────

test("runSkillInit: scaffolds a single skill and registers it with the bank", async () => {
  const fx = await setup();
  try {
    const result = await runSkillInit(
      { name: "echo-test", dir: fx.scaffoldDir },
      { bank: fx.bank, embedder: fx.embedder },
    );

    assert.equal(result.init.mode, "skill");
    assert.equal(result.subscribed, true);
    assert.ok(result.identity);
    // Identity is the synthetic `local:<abs-path>@dev/<id>` shape.
    assert.match(result.identity!, /^local:.+@dev\/echo-test$/);

    // SKILL.md is written under runInit's standard layout
    // `<root>/skills/<name>/SKILL.md`.
    const skillMdStat = await stat(
      join(result.init.root, "skills", "echo-test", "SKILL.md"),
    );
    assert.ok(skillMdStat.isFile());

    // The bank has exactly one skill, ours.
    const skills = await fx.bank.listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.identity, result.identity);
  } finally {
    await fx.cleanup();
  }
});

test("runSkillInit: subscribed skill has signature_status=unsigned", async () => {
  // Per the pre-flight: signing is publish-time, not init-time. Locally
  // scaffolded skills register as unsigned and the user invokes via
  // --allow-unsigned during dev. This test pins that contract.
  const fx = await setup();
  try {
    await runSkillInit(
      { name: "unsigned-skill", dir: fx.scaffoldDir },
      { bank: fx.bank, embedder: fx.embedder },
    );
    const skills = await fx.bank.listSkills();
    assert.equal(skills[0]?.provenance.signature_status, "unsigned");
  } finally {
    await fx.cleanup();
  }
});

test("runSkillInit: synthetic provenance uses local: source URI", async () => {
  // SkillProvenance.source_type is enum-narrow ("git" only). The harness
  // synthesizes a `local:` URI in the source field as the disambiguator
  // until upstream extends the enum to include "local". This pin
  // catches an accidental change to the synthesis shape.
  const fx = await setup();
  try {
    await runSkillInit(
      { name: "provenance-test", dir: fx.scaffoldDir },
      { bank: fx.bank, embedder: fx.embedder },
    );
    const skills = await fx.bank.listSkills();
    assert.equal(skills[0]?.provenance.source_type, "git");
    assert.match(skills[0]?.provenance.source ?? "", /^local:/);
    assert.equal(skills[0]?.provenance.ref_resolved_to, "dev");
  } finally {
    await fx.cleanup();
  }
});

test("runSkillInit: embedding is computed using the embedder's name", async () => {
  // Bank-side mismatch detection relies on embedding_model being set
  // accurately. If we ever forget to thread the embedder name through
  // the indexed skill, retrieval breaks silently.
  const fx = await setup();
  try {
    await runSkillInit(
      { name: "embedding-test", dir: fx.scaffoldDir },
      { bank: fx.bank, embedder: fx.embedder },
    );
    const skills = await fx.bank.listSkills();
    assert.equal(skills[0]?.embedding_model, "toy");
    assert.equal(skills[0]?.embedding.length, 16);
  } finally {
    await fx.cleanup();
  }
});

// ─── --no-subscribe ────────────────────────────────────────────────────────

test("runSkillInit: --no-subscribe scaffolds without registering", async () => {
  const fx = await setup();
  try {
    const result = await runSkillInit(
      { name: "scaffold-only", dir: fx.scaffoldDir, noSubscribe: true },
      { bank: fx.bank, embedder: fx.embedder },
    );
    assert.equal(result.subscribed, false);
    assert.equal(result.identity, undefined);

    // Files were written under the standard `<root>/skills/<name>/` layout.
    const skillMdStat = await stat(
      join(result.init.root, "skills", "scaffold-only", "SKILL.md"),
    );
    assert.ok(skillMdStat.isFile());

    // Bank is empty.
    const skills = await fx.bank.listSkills();
    assert.equal(skills.length, 0);
  } finally {
    await fx.cleanup();
  }
});

// ─── --pack mode ───────────────────────────────────────────────────────────

test("runSkillInit: --pack scaffolds a pack and skips subscribe", async () => {
  // Pack mode produces a multi-skill scaffold; the user authors skills
  // inside and publishes via the upstream agent-skills CLI later. There's
  // no single skill to register at init time.
  const fx = await setup();
  try {
    const result = await runSkillInit(
      { name: "my-pack", dir: fx.scaffoldDir, pack: true },
      { bank: fx.bank, embedder: fx.embedder },
    );
    assert.equal(result.init.mode, "pack");
    assert.equal(result.subscribed, false);
    assert.equal(result.identity, undefined);

    // Bank is empty even though the scaffold succeeded.
    const skills = await fx.bank.listSkills();
    assert.equal(skills.length, 0);
  } finally {
    await fx.cleanup();
  }
});

// ─── error / overwrite paths ───────────────────────────────────────────────

test("runSkillInit: --force allows re-scaffolding over an existing skill", async () => {
  const fx = await setup();
  try {
    await runSkillInit(
      { name: "overwriteable", dir: fx.scaffoldDir },
      { bank: fx.bank, embedder: fx.embedder },
    );
    // Second run with --force should succeed (and re-upsert into the bank,
    // which dedupes by identity → still 1 skill).
    const result = await runSkillInit(
      { name: "overwriteable", dir: fx.scaffoldDir, force: true },
      { bank: fx.bank, embedder: fx.embedder },
    );
    assert.equal(result.subscribed, true);
    const skills = await fx.bank.listSkills();
    assert.equal(skills.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("runSkillInit: scaffolded SKILL.md has the expected id in frontmatter", async () => {
  // Sanity test: catches the case where runInit's templating diverges
  // from the requested name (would manifest as identity / id mismatch).
  const fx = await setup();
  try {
    const result = await runSkillInit(
      { name: "id-roundtrip", dir: fx.scaffoldDir },
      { bank: fx.bank, embedder: fx.embedder },
    );
    const source = await readFile(
      join(result.init.root, "skills", "id-roundtrip", "SKILL.md"),
      "utf8",
    );
    // runInit emits YAML with quoted strings (`id: "id-roundtrip"`).
    assert.match(source, /^id:\s*"?id-roundtrip"?\s*$/m);
    // And the bank entry agrees.
    const skills = await fx.bank.listSkills();
    assert.equal(skills[0]?.id, "id-roundtrip");
  } finally {
    await fx.cleanup();
  }
});
