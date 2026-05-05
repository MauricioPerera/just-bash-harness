// Regression smoke: `compaction.summarize.enabled: false` must produce
// a systemPrompt byte-identical to the v0.1.7 path (slice + memory recall
// only — no `Earlier conversation digest` block). The "strict additive"
// claim made for issue #1 in v0.3.0 has no unit-test guard because
// loop.test.ts deliberately doesn't mock the full runTurn cascade.
//
// This smoke spins up a real session with compaction triggering (33 turns,
// windowSize=10) and verifies via SpyProvider that:
//   - The systemPrompt never contains the digest header.
//   - The history actually got sliced (compaction is firing — not vacuously
//     passing because compaction never triggered).
//   - The summarize-disabled provider was called exactly once per turn
//     (no extra summary call sneaking through).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileBank, type EmbeddingProvider } from "@rckflr/agent-skills-cli";

import { createToolbox } from "../src/toolbox.js";
import { createSessionStore } from "../src/session.js";
import { createApprovalGate } from "../src/approval.js";
import { runTurn } from "../src/loop.js";
import { createMemoryStore, type Memory } from "../src/memory.js";
import type { Policy, Provider, TurnEvent, TurnInput } from "../src/types.js";

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const toyEmbedder = (dim = 32): EmbeddingProvider => ({
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

interface SpyState {
  capturedInputs: TurnInput[];
}

const spyProvider = (
  scripts: ReadonlyArray<readonly TurnEvent[]>,
): { provider: Provider; state: SpyState } => {
  const state: SpyState = { capturedInputs: [] };
  let i = 0;
  const provider: Provider = {
    async *turn(input: TurnInput): AsyncIterable<TurnEvent> {
      state.capturedInputs.push(structuredClone(input));
      const script = scripts[i++] ?? [];
      for (const evt of script) yield evt;
    },
  };
  return { provider, state };
};

const buildPolicy = (
  sessionsRoot: string,
  skillsBankDir: string,
  memoryRoot: string,
  compaction: Policy["memory"]["compaction"],
): Policy => ({
  version: 1,
  skills: { subscribed: [], overrides: {} },
  signature: { require_signed: false },
  approval: { matrix: { prohibited: "deny", explicit: "ask", regular: "allow" } },
  limits: { maxTurns: 1000, maxToolCallsPerTurn: 10, maxWallclockMs: 60_000 },
  paths: { sessionsRoot, skillsBankDir },
  memory: {
    enabled: true,
    rootDir: memoryRoot,
    recall: { topK: 0, charBudget: 0 },
    persist: { autoPersistTurns: true, minMessageLength: 1 },
    compaction,
  },
  encryption: { enabled: false },
});

const TOTAL_TURNS = 33;
const WINDOW_SIZE = 10;
const DIGEST_HEADER = "Earlier conversation digest";

const main = async (): Promise<void> => {
  const memoryRoot = await mkdtemp(join(tmpdir(), "compact-no-sum-mem-"));
  const sessionsRoot = await mkdtemp(join(tmpdir(), "compact-no-sum-sess-"));
  const skillsRoot = await mkdtemp(join(tmpdir(), "compact-no-sum-skills-"));
  const cleanup = async (): Promise<void> => {
    for (const d of [memoryRoot, sessionsRoot, skillsRoot]) {
      await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail?: string): void => {
    if (ok) {
      console.log(`  ✓ ${name}`);
      pass++;
    } else {
      console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
      fail++;
    }
  };

  try {
    const bank = new FileBank({ rootDir: skillsRoot });
    await bank.initMeta({ embedding_model: "toy", embedding_dim: 32 });

    const memory: Memory = createMemoryStore({
      rootDir: memoryRoot,
      embedder: toyEmbedder(32),
    });

    console.log("=".repeat(72));
    console.log(
      `SUMMARIZE-DISABLED REGRESSION — ${TOTAL_TURNS} turns, windowSize=${WINDOW_SIZE}, summarize.enabled=false`,
    );
    console.log("=".repeat(72));

    // Compaction enabled, summarize explicitly disabled — this is the
    // v0.1.7 behavior that 0.3.0's issue #1 promises to preserve.
    const policy = buildPolicy(sessionsRoot, skillsRoot, memoryRoot, {
      enabled: true,
      windowSize: WINDOW_SIZE,
      summarize: { enabled: false, maxTokens: 1500 },
    });
    const sessionStore = createSessionStore({
      sessionsRoot,
      loadPolicy: () => Promise.resolve(policy),
    });
    const toolbox = createToolbox({
      bank,
      embedder: { name: "toy", dim: 32, embed: async () => stubVec() },
    });
    const approval = createApprovalGate({
      policy,
      audit: async () => undefined,
    });

    const sessionId = await sessionStore.create({
      policyPath: "<summarize-disabled>",
      sessionRoot: sessionsRoot,
    });

    let sawCompactionTrigger = false;
    let sawDigestInPrompt = false;
    let totalProviderCalls = 0;

    for (let i = 1; i <= TOTAL_TURNS; i++) {
      const { provider, state } = spyProvider([
        [
          { type: "text", delta: `assistant reply #${i}` },
          { type: "stop", reason: "end_turn" },
        ],
      ]);
      await runTurn(
        {
          provider,
          toolbox,
          approval,
          session: sessionStore,
          policy,
          memory,
        },
        {
          sessionId,
          userMessage: `user msg #${i}`,
        },
      );

      // Inspect what the provider saw on this runTurn.
      for (const captured of state.capturedInputs) {
        totalProviderCalls++;
        if (captured.systemPrompt.includes(DIGEST_HEADER)) {
          sawDigestInPrompt = true;
        }
        if (captured.history.length < i - 1) {
          // History was sliced — compaction fired.
          sawCompactionTrigger = true;
        }
      }
    }

    // Assertions.
    check(
      `compaction actually triggered (sliced history seen)`,
      sawCompactionTrigger,
      sawCompactionTrigger ? undefined : "test would vacuously pass otherwise",
    );
    check(
      `systemPrompt NEVER contained "${DIGEST_HEADER}" (summarize=false honored)`,
      !sawDigestInPrompt,
    );
    check(
      `provider called exactly once per turn (no surprise summary call)`,
      totalProviderCalls === TOTAL_TURNS,
      `got ${totalProviderCalls}, expected ${TOTAL_TURNS}`,
    );

    // Bonus: with summarize disabled, no compaction-summary memory should exist.
    const summaryMems = await memory.recall("Earlier conversation digest", {
      topK: 5,
      charBudget: 5000,
    });
    const summaryKindHits = summaryMems.filter(
      (m) => m.kind === "compaction-summary",
    );
    check(
      `no compaction-summary memory record was persisted`,
      summaryKindHits.length === 0,
      `found ${summaryKindHits.length}`,
    );

    console.log("─".repeat(72));
    console.log(`pass: ${pass}, fail: ${fail}`);
    if (fail > 0) {
      console.log(
        `\n  REGRESSION DETECTED — summarize=false path no longer matches v0.1.7 behavior.`,
      );
      process.exit(1);
    }
  } finally {
    await cleanup();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
