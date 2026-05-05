// Tests for the small testable helpers exported from loop.ts. The full
// runTurn integration is covered by smoke scripts (scratch/), not by
// unit tests — too many moving parts (provider, toolbox, session,
// approval gate, memory) to mock cleanly without diluting signal.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { runCompactionSummary, synthesizeUnknownChainStep } from "./loop.js";
import type { Provider, Turn, TurnEvent, TurnInput } from "./types.js";

const turn = (overrides: Partial<Turn> = {}): Turn =>
  ({
    id: "t_test_001" as Turn["id"],
    ts: "2026-05-05T00:00:00Z",
    input: { user: "do the thing" },
    output: {
      text: "did the thing",
      toolCalls: [],
      stopReason: "end_turn",
    },
    approvals: [],
    ...overrides,
  }) as Turn;

/** A provider that yields a fixed text and stops. Lets us assert what
 *  TurnInput the summarizer constructed. */
const makeStubProvider = (
  responseText: string,
  capture: { input?: TurnInput },
): Provider => ({
  async *turn(input: TurnInput): AsyncIterable<TurnEvent> {
    capture.input = input;
    yield { type: "text", delta: responseText };
    yield { type: "stop", reason: "end_turn" };
  },
});

test("runCompactionSummary: collects text events and returns the joined string", async () => {
  const capture: { input?: TurnInput } = {};
  const provider = makeStubProvider("DIGEST: user wanted X, agent did Y.", capture);
  const out = await runCompactionSummary(provider, [turn()], 1500);
  assert.equal(out, "DIGEST: user wanted X, agent did Y.");
});

test("runCompactionSummary: passes a SUMMARY system prompt with budget hint", async () => {
  const capture: { input?: TurnInput } = {};
  const provider = makeStubProvider("ok", capture);
  await runCompactionSummary(provider, [turn()], 800);
  assert.ok(capture.input);
  assert.match(capture.input!.systemPrompt, /summarizing/);
  assert.match(capture.input!.systemPrompt, /Output budget: ~800 tokens/);
  // No tools available to the summary call.
  assert.equal(capture.input!.availableTools.length, 0);
});

test("runCompactionSummary: encodes dropped turn shape into the user message", async () => {
  const capture: { input?: TurnInput } = {};
  const provider = makeStubProvider("ok", capture);
  const dropped = [
    turn({
      input: { user: "search the codebase for X" },
      output: {
        text: "I'll search now.",
        toolCalls: [
          {
            id: "c1",
            skillId: "github.com/foo/skills/grep",
            args: { pattern: "X" },
          },
        ],
        stopReason: "end_turn",
      },
    } as unknown as Turn),
  ];
  await runCompactionSummary(provider, dropped, 1000);
  const u = capture.input!.user!;
  assert.match(u, /USER: search the codebase for X/);
  assert.match(u, /ASSISTANT: I'll search now\./);
  assert.match(u, /TOOLS_CALLED:/);
  assert.match(u, /grep\(/);
});

test("runCompactionSummary: caps massive input at 50K chars + truncation marker", async () => {
  const capture: { input?: TurnInput } = {};
  const provider = makeStubProvider("ok", capture);
  // Build one turn whose ASSISTANT text alone exceeds 50K chars.
  const huge = "x".repeat(60_000);
  const dropped = [
    turn({
      output: { text: huge, toolCalls: [], stopReason: "end_turn" },
    }),
  ];
  await runCompactionSummary(provider, dropped, 1000);
  const u = capture.input!.user!;
  assert.ok(u.length <= 50_100, `expected ≤50_100 chars, got ${u.length}`);
  assert.match(u, /\[\.\.\. truncated for summary call \.\.\.\]/);
});

test("runCompactionSummary: empty dropped → empty user message, still calls provider", async () => {
  const capture: { input?: TurnInput } = {};
  const provider = makeStubProvider("nothing to summarize", capture);
  const out = await runCompactionSummary(provider, [], 1000);
  assert.equal(out, "nothing to summarize");
  assert.equal(capture.input!.user, "");
});

test("runCompactionSummary: stops on first stop event (ignores later)", async () => {
  // Provider yields two stops; we should still get only the text emitted
  // before / between (not yields after the first stop).
  const provider: Provider = {
    async *turn(): AsyncIterable<TurnEvent> {
      yield { type: "text", delta: "A" };
      yield { type: "stop", reason: "end_turn" };
      yield { type: "text", delta: "B" };
    },
  };
  const out = await runCompactionSummary(provider, [turn()], 1000);
  assert.equal(out, "A");
});

// Sanity: the existing chain-step synthesis import still resolves through loop.ts.
test("loop.ts barrel: synthesizeUnknownChainStep is still re-exported", () => {
  // Defensive — protects against accidental rename when refactoring loop.ts.
  assert.equal(typeof synthesizeUnknownChainStep, "function");
});
