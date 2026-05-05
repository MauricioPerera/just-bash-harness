// Compaction smoke: build a session with N turns, then with compaction
// enabled and windowSize=K, verify that the provider sees only the last K
// turns in `input.history` while the session db still has all N.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileBank, type EmbeddingProvider } from "@rckflr/agent-skills-cli";

import { createToolbox } from "../src/toolbox.js";
import { createSessionStore } from "../src/session.js";
import { createApprovalGate } from "../src/approval.js";
import { runTurn } from "../src/loop.js";
import { createMemoryStore } from "../src/memory.js";
import type { Memory } from "../src/memory.js";
import type {
  Policy,
  Provider,
  TurnEvent,
  TurnInput,
} from "../src/types.js";

// ─── helpers ──────────────────────────────────────────────────────────────

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
  compaction: { enabled: boolean; windowSize: number },
): Policy => ({
  version: 1,
  skills: { subscribed: [], overrides: {} },
  signature: { require_signed: false },
  approval: {
    matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
  },
  limits: { maxTurns: 1000, maxToolCallsPerTurn: 10, maxWallclockMs: 60_000 },
  paths: { sessionsRoot, skillsBankDir },
  memory: {
    enabled: true,
    rootDir: memoryRoot,
    recall: { topK: 0, charBudget: 0 }, // disable recall for clarity
    persist: { autoPersistTurns: true, minMessageLength: 1 },
    compaction,
  },
  encryption: { enabled: false },
});

// ─── main ────────────────────────────────────────────────────────────────

const TOTAL_TURNS = 30;
const WINDOW_SIZE = 10;

const main = async (): Promise<void> => {
  const memoryRoot = await mkdtemp(join(tmpdir(), "compact-mem-"));
  const sessionsRoot = await mkdtemp(join(tmpdir(), "compact-sess-"));
  const skillsRoot = await mkdtemp(join(tmpdir(), "compact-skills-"));
  const cleanup = async (): Promise<void> => {
    for (const d of [memoryRoot, sessionsRoot, skillsRoot]) {
      await rm(d, { recursive: true, force: true }).catch(() => undefined);
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
      `COMPACTION SMOKE — ${TOTAL_TURNS} turns, windowSize=${WINDOW_SIZE}`,
    );
    console.log("=".repeat(72));

    // Phase 1: build up TOTAL_TURNS turns with compaction OFF so each runTurn
    // sees the cumulative history grow naturally. This populates session +
    // memory the same way a normal session would.
    const phase1Policy = buildPolicy(sessionsRoot, skillsRoot, memoryRoot, {
      enabled: false,
      windowSize: WINDOW_SIZE,
    });
    const sessionStore1 = createSessionStore({
      sessionsRoot,
      loadPolicy: () => Promise.resolve(phase1Policy),
    });
    const toolbox = createToolbox({
      bank,
      embedder: { name: "toy", dim: 32, embed: async () => stubVec() },
    });
    const approval = createApprovalGate({
      policy: phase1Policy,
      audit: async () => undefined,
    });

    const sessionId = await sessionStore1.create({
      policyPath: "<compaction-test>",
      sessionRoot: sessionsRoot,
    });
    console.log(`session: ${sessionId}`);
    console.log(`building ${TOTAL_TURNS} turns (compaction off)...`);

    for (let i = 1; i <= TOTAL_TURNS; i++) {
      const { provider } = spyProvider([
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
          session: sessionStore1,
          policy: phase1Policy,
          memory,
        },
        {
          sessionId,
          userMessage: `user message #${i}`,
        },
      );
    }
    const fullSession = await sessionStore1.load(sessionId);
    console.log(`  session.turns persisted: ${fullSession.turns.length}`);
    console.log(`  memory.size: ${await memory.size()}`);

    // Phase 2: compaction ON. Run ONE more turn with a SpyProvider; assert
    // that the provider's TurnInput.history has exactly windowSize entries.
    const phase2Policy = buildPolicy(sessionsRoot, skillsRoot, memoryRoot, {
      enabled: true,
      windowSize: WINDOW_SIZE,
    });
    const sessionStore2 = createSessionStore({
      sessionsRoot,
      loadPolicy: () => Promise.resolve(phase2Policy),
    });

    const { provider: spyProv2, state } = spyProvider([
      [
        { type: "text", delta: "compacted reply" },
        { type: "stop", reason: "end_turn" },
      ],
    ]);

    await runTurn(
      {
        provider: spyProv2,
        toolbox,
        approval,
        session: sessionStore2,
        policy: phase2Policy,
        memory,
      },
      {
        sessionId,
        userMessage: "compacted message",
      },
    );

    console.log("");
    console.log("─── verifications ──────────────────────────────────────");

    let pass = 0;
    let fail = 0;
    const check = (name: string, ok: boolean, hint?: string): void => {
      if (ok) {
        console.log(`  ✓ ${name}`);
        pass++;
      } else {
        console.log(`  ✗ ${name}${hint ? ` — ${hint}` : ""}`);
        fail++;
      }
    };

    const captured = state.capturedInputs[0];
    check(
      `provider received TurnInput.history with exactly ${WINDOW_SIZE} entries`,
      captured?.history.length === WINDOW_SIZE,
      `got ${captured?.history.length ?? "(no input)"}`,
    );

    // The slice keeps the LAST windowSize turns. The latest pre-existing
    // turn is "user message #30 → assistant reply #30". The earliest
    // included should be "user message #21".
    const earliest = captured?.history[0];
    const latest = captured?.history[captured.history.length - 1];
    check(
      `oldest active turn is the (TOTAL_TURNS - WINDOW_SIZE + 1)th original`,
      earliest?.input.user === `user message #${TOTAL_TURNS - WINDOW_SIZE + 1}`,
      `oldest user msg was ${JSON.stringify(earliest?.input.user)}`,
    );
    check(
      `newest active turn is the (TOTAL_TURNS)th original`,
      latest?.input.user === `user message #${TOTAL_TURNS}`,
      `newest user msg was ${JSON.stringify(latest?.input.user)}`,
    );

    // Audit: full session db should still have all original turns + the new one.
    const reloadedFull = await sessionStore2.load(sessionId);
    check(
      `session db retains all turns regardless of compaction (audit invariant)`,
      reloadedFull.turns.length === TOTAL_TURNS + 1,
      `db turns count = ${reloadedFull.turns.length}`,
    );

    // Memory: should have all auto-persisted turns + the new one.
    check(
      `memory has all auto-persisted turns (>= TOTAL_TURNS)`,
      (await memory.size()) >= TOTAL_TURNS,
      `memory.size = ${await memory.size()}`,
    );

    console.log("");
    console.log(`${pass}/${pass + fail} checks passed`);

    if (fail === 0) {
      console.log("");
      console.log(
        "PASS — compaction caps the provider window while session+memory retain everything.",
      );
      console.log(
        `Provider sees ${WINDOW_SIZE}/${TOTAL_TURNS + 1} most recent turns; the rest stays in db turns + memory.`,
      );
      process.exit(0);
    }
    process.exit(1);
  } finally {
    await cleanup();
  }
};

main().catch((err) => {
  console.error("compaction smoke crashed:", err);
  process.exit(2);
});
