// Cross-session memory smoke test.
//
// Two sessions using the same memory store. The first session sets a fact
// via a normal turn; the second session asks a related question and the
// captured systemPrompt is asserted to contain the recalled memory.
//
// No real LLM needed: a "spy provider" records what it receives and replays
// scripted events. The harness's memory plumbing is what's under test.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
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

/** Toy embedder that produces small but discriminating vectors. */
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

interface SpyProvider {
  provider: Provider;
  capturedInputs: TurnInput[];
}

const spyProvider = (
  scripts: ReadonlyArray<readonly TurnEvent[]>,
): SpyProvider => {
  const captured: TurnInput[] = [];
  let i = 0;
  const provider: Provider = {
    async *turn(input: TurnInput): AsyncIterable<TurnEvent> {
      captured.push(structuredClone(input));
      const script = scripts[i++] ?? [];
      for (const evt of script) yield evt;
    },
  };
  return { provider, capturedInputs: captured };
};

// ─── harness setup ───────────────────────────────────────────────────────

interface Setup {
  policy: Policy;
  memory: Memory;
  cleanup: () => Promise<void>;
}

const setupShared = async (): Promise<Setup> => {
  const memoryRoot = await mkdtemp(join(tmpdir(), "live-mem-"));
  const sessionsRoot = await mkdtemp(join(tmpdir(), "live-mem-sess-"));
  const skillsRoot = await mkdtemp(join(tmpdir(), "live-mem-skills-"));

  const policy: Policy = {
    version: 1,
    skills: { subscribed: [], overrides: {} },
    signature: { require_signed: false },
    approval: {
      matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
    },
    limits: { maxTurns: 50, maxToolCallsPerTurn: 10, maxWallclockMs: 60_000 },
    paths: { sessionsRoot, skillsBankDir: skillsRoot },
    memory: {
      enabled: true,
      rootDir: memoryRoot,
      recall: { topK: 5, charBudget: 6000 },
      persist: { autoPersistTurns: true, minMessageLength: 5 },
      compaction: { enabled: false, windowSize: 50 },
    },
    encryption: { enabled: false },
  };

  const memory = createMemoryStore({
    rootDir: memoryRoot,
    embedder: toyEmbedder(32),
  });

  return {
    policy,
    memory,
    cleanup: async () => {
      await rm(memoryRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(sessionsRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
    },
  };
};

// ─── run ─────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const setup = await setupShared();
  const { policy, memory, cleanup } = setup;
  void homedir; // keep import as a documentation hint

  try {
    // Fresh skills bank with no skills (we only test memory wiring).
    const bank = new FileBank({ rootDir: policy.paths.skillsBankDir! });
    await bank.initMeta({ embedding_model: "toy", embedding_dim: 32 });

    const sessionStore = createSessionStore({
      sessionsRoot: policy.paths.sessionsRoot,
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

    console.log("=".repeat(72));
    console.log("CROSS-SESSION MEMORY SMOKE");
    console.log("=".repeat(72));

    // ── SESSION 1 ──────────────────────────────────────────────────────
    // The user reveals a fact; the harness persists the turn as memory.

    const session1Id = await sessionStore.create({
      policyPath: "<live-test-memory>",
      sessionRoot: policy.paths.sessionsRoot,
    });
    console.log(`session 1: ${session1Id}`);

    const spy1 = spyProvider([
      [
        {
          type: "text",
          delta: "Got it — I'll remember that you prefer concise answers.",
        },
        { type: "stop", reason: "end_turn" },
      ],
    ]);

    await runTurn(
      { provider: spy1.provider, toolbox, approval, session: sessionStore, policy, memory },
      {
        sessionId: session1Id,
        userMessage:
          "Please remember: I prefer concise, terse answers without filler. Also I'm working on a TypeScript harness called just-bash-harness.",
      },
    );

    const sizeAfter1 = await memory.size();
    console.log(`  memory size after session 1: ${sizeAfter1}`);

    // ── SESSION 2 ──────────────────────────────────────────────────────
    // Different session id. User asks a related question. The harness
    // should recall the session-1 fact and inject it into systemPrompt.

    const session2Id = await sessionStore.create({
      policyPath: "<live-test-memory>",
      sessionRoot: policy.paths.sessionsRoot,
    });
    console.log(`session 2: ${session2Id}`);

    const spy2 = spyProvider([
      [
        { type: "text", delta: "Sure — given your preference, here's the brief answer." },
        { type: "stop", reason: "end_turn" },
      ],
    ]);

    await runTurn(
      { provider: spy2.provider, toolbox, approval, session: sessionStore, policy, memory },
      {
        sessionId: session2Id,
        userMessage:
          "How should I phrase a response to the user about TypeScript harness packaging?",
      },
    );

    // ── ASSERTIONS ─────────────────────────────────────────────────────

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

    check("session 1 persisted exactly 1 memory", sizeAfter1 === 1);

    const session1SystemPrompt = spy1.capturedInputs[0]?.systemPrompt ?? "";
    check(
      "session 1 systemPrompt has NO 'Relevant memories' block (empty memory at the time)",
      !session1SystemPrompt.includes("Relevant memories"),
    );

    const session2SystemPrompt = spy2.capturedInputs[0]?.systemPrompt ?? "";
    check(
      "session 2 systemPrompt INCLUDES 'Relevant memories' block",
      session2SystemPrompt.includes("Relevant memories"),
      `prompt was: ${session2SystemPrompt.slice(0, 200)}...`,
    );
    check(
      "session 2 systemPrompt cites the session-1 user message content",
      session2SystemPrompt.includes("concise") ||
        session2SystemPrompt.includes("terse") ||
        session2SystemPrompt.includes("just-bash-harness"),
      "memory recall didn't surface session-1 content",
    );

    const sizeAfter2 = await memory.size();
    check(
      "session 2 added a second memory record",
      sizeAfter2 === 2,
      `size=${sizeAfter2}`,
    );

    console.log("");
    console.log(`${pass}/${pass + fail} checks passed`);

    if (fail === 0) {
      console.log("");
      console.log("PASS — cross-session memory plumbing works end-to-end.");
      // Echo a sample of what session 2's provider actually saw, for posterity.
      console.log("");
      console.log("Sample of session-2 systemPrompt (first 500 chars):");
      console.log(session2SystemPrompt.slice(0, 500));
      console.log("...");
      process.exit(0);
    }
    process.exit(1);
  } finally {
    await cleanup();
  }
};

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(2);
});
