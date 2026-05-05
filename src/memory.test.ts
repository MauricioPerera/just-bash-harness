import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "@rckflr/agent-skills-cli";

import { createMemoryStore, type Memory } from "./memory.js";

// ─── helpers ──────────────────────────────────────────────────────────────

/** Toy embedder: maps strings to a small vector by character codes. Two
 *  similar strings → similar vectors. Deterministic and synchronous-feeling. */
const toyEmbedder = (dim = 16): EmbeddingProvider => ({
  name: "toy",
  dim,
  async embed(text) {
    const v = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[i % dim]! += (text.charCodeAt(i) % 17) / 17;
    }
    // Normalize to unit length so cosine similarity is meaningful.
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  },
});

const setup = async (): Promise<{ memory: Memory; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "memory-test-"));
  const memory = createMemoryStore({ rootDir: dir, embedder: toyEmbedder(16) });
  return {
    memory,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
};

// ─── remember + size ──────────────────────────────────────────────────────

test("memory: empty store → size 0, recall returns []", async () => {
  const { memory, cleanup } = await setup();
  try {
    assert.equal(await memory.size(), 0);
    const hits = await memory.recall("anything");
    assert.equal(hits.length, 0);
  } finally {
    await cleanup();
  }
});

test("memory: remember increases size and returns id", async () => {
  const { memory, cleanup } = await setup();
  try {
    const id = await memory.remember("the user prefers terse responses", {
      kind: "fact",
    });
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
    assert.equal(await memory.size(), 1);
  } finally {
    await cleanup();
  }
});

// ─── recall: similarity ranking ───────────────────────────────────────────

test("memory: recall ranks similar content highest", async () => {
  const { memory, cleanup } = await setup();
  try {
    await memory.remember("the user prefers terse responses", { kind: "fact" });
    await memory.remember("the weather is nice today", { kind: "fact" });
    await memory.remember("python is a programming language", { kind: "fact" });

    const hits = await memory.recall("how should I respond to the user?", {
      topK: 3,
    });
    assert.ok(hits.length > 0, "expected at least one hit");
    // Top hit should be the response-preference fact (most lexically similar).
    assert.match(hits[0]!.content, /terse responses|prefers/);
  } finally {
    await cleanup();
  }
});

// ─── recall: kind filter ─────────────────────────────────────────────────

test("memory: recall with kind filter returns only matching kind", async () => {
  const { memory, cleanup } = await setup();
  try {
    await memory.remember("a generic fact about cats", { kind: "fact" });
    await memory.remember("turn 1 transcript: hello!", { kind: "turn" });
    await memory.remember("turn 2 transcript: goodbye", { kind: "turn" });

    const factsOnly = await memory.recall("anything", {
      topK: 10,
      kind: "fact",
    });
    assert.ok(factsOnly.every((r) => r.kind === "fact"));
    assert.equal(factsOnly.length, 1);

    const turnsOnly = await memory.recall("anything", {
      topK: 10,
      kind: "turn",
    });
    assert.ok(turnsOnly.every((r) => r.kind === "turn"));
    assert.equal(turnsOnly.length, 2);
  } finally {
    await cleanup();
  }
});

// ─── recall: sessionId filter ────────────────────────────────────────────

test("memory: recall with sessionId filter returns only that session's records", async () => {
  const { memory, cleanup } = await setup();
  try {
    await memory.remember("session A note 1", {
      kind: "turn",
      sessionId: "s_A",
    });
    await memory.remember("session A note 2", {
      kind: "turn",
      sessionId: "s_A",
    });
    await memory.remember("session B note 1", {
      kind: "turn",
      sessionId: "s_B",
    });

    const aOnly = await memory.recall("session note", {
      topK: 10,
      sessionId: "s_A",
    });
    assert.equal(aOnly.length, 2);
    assert.ok(aOnly.every((r) => r.sessionId === "s_A"));
  } finally {
    await cleanup();
  }
});

// ─── recall: charBudget caps content total ───────────────────────────────

test("memory: recall respects charBudget", async () => {
  const { memory, cleanup } = await setup();
  try {
    // Three records of ~50 chars each.
    await memory.remember("a".repeat(50), { kind: "f", title: "a" });
    await memory.remember("b".repeat(50), { kind: "f", title: "b" });
    await memory.remember("c".repeat(50), { kind: "f", title: "c" });

    const limited = await memory.recall("anything", {
      topK: 10,
      charBudget: 80, // can fit 1 record (50 chars), not 2 (100).
    });
    assert.equal(limited.length, 1);
  } finally {
    await cleanup();
  }
});

test("memory: recall always returns at least one record even if it exceeds budget", async () => {
  // Documented behavior: budget kicks in only after the first record. A
  // single huge record still gets returned. This avoids "I have a memory
  // for that exact query but the budget hid it".
  const { memory, cleanup } = await setup();
  try {
    await memory.remember("x".repeat(500), { kind: "f", title: "huge" });
    const hits = await memory.recall("anything", { charBudget: 50 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.content.length, 500);
  } finally {
    await cleanup();
  }
});

// ─── forget ──────────────────────────────────────────────────────────────

test("memory: forget by id removes one record", async () => {
  const { memory, cleanup } = await setup();
  try {
    const id1 = await memory.remember("first", { kind: "f", title: "1" });
    await memory.remember("second", { kind: "f", title: "2" });
    assert.equal(await memory.size(), 2);

    const deleted = await memory.forget({ id: id1 });
    assert.equal(deleted, 1);
    assert.equal(await memory.size(), 1);
  } finally {
    await cleanup();
  }
});

test("memory: forget by kind bulk deletes", async () => {
  const { memory, cleanup } = await setup();
  try {
    await memory.remember("fact 1", { kind: "fact" });
    await memory.remember("fact 2", { kind: "fact" });
    await memory.remember("turn 1", { kind: "turn" });
    assert.equal(await memory.size(), 3);

    const deleted = await memory.forget({ kind: "fact" });
    assert.equal(deleted, 2);
    assert.equal(await memory.size(), 1);
  } finally {
    await cleanup();
  }
});

test("memory: forget by sessionId only deletes that session's records", async () => {
  const { memory, cleanup } = await setup();
  try {
    await memory.remember("a1", { kind: "turn", sessionId: "s_A" });
    await memory.remember("a2", { kind: "turn", sessionId: "s_A" });
    await memory.remember("b1", { kind: "turn", sessionId: "s_B" });

    const deleted = await memory.forget({ sessionId: "s_A" });
    assert.equal(deleted, 2);

    const remaining = await memory.list();
    assert.equal(remaining.length, 1);
  } finally {
    await cleanup();
  }
});

// ─── list ────────────────────────────────────────────────────────────────

test("memory: list returns shallow records", async () => {
  const { memory, cleanup } = await setup();
  try {
    await memory.remember("c1", { kind: "fact", title: "fact-1" });
    await memory.remember("c2", { kind: "turn", title: "turn-1" });

    const all = await memory.list();
    assert.equal(all.length, 2);
    const titles = all.map((r) => r.title).sort();
    assert.deepEqual(titles, ["fact-1", "turn-1"]);
  } finally {
    await cleanup();
  }
});

test("memory: list with kind filter", async () => {
  const { memory, cleanup } = await setup();
  try {
    await memory.remember("c1", { kind: "fact", title: "fact-1" });
    await memory.remember("c2", { kind: "turn", title: "turn-1" });
    await memory.remember("c3", { kind: "fact", title: "fact-2" });

    const facts = await memory.list({ kind: "fact" });
    assert.equal(facts.length, 2);
    assert.ok(facts.every((r) => r.kind === "fact"));
  } finally {
    await cleanup();
  }
});
