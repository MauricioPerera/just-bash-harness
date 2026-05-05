import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildMessages,
  buildSystemParam,
  buildTools,
  createAnthropicProvider,
  mapStopReason,
  shortIdFromIdentity,
  toInputSchema,
  toolNameOf,
  toolResultBlocks,
} from "./provider-anthropic.js";
import type {
  Provider,
  SkillId,
  SkillSummary,
  Turn,
  TurnEvent,
  TurnInput,
} from "./types.js";

// ─── fixtures ──────────────────────────────────────────────────────────────

const ECHO_ID =
  "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo" as SkillId;

const echoSummary = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id: ECHO_ID,
  shortId: "echo",
  title: "Echo",
  description: "Echoes a message",
  use_when: "to print a string",
  pack: "github.com/test/pack",
  version: "1.0.0",
  signatureStatus: "valid",
  network: [],
  filesystem: [],
  idempotent: true,
  args: { msg: { type: "string" } },
  ...overrides,
});

// ─── shortIdFromIdentity ───────────────────────────────────────────────────

test("shortIdFromIdentity: full identity → last path segment", () => {
  assert.equal(shortIdFromIdentity(ECHO_ID), "echo");
});

test("shortIdFromIdentity: nested path returns last segment", () => {
  assert.equal(
    shortIdFromIdentity(
      "github.com/foo/bar@abc/skills/nested/handler" as SkillId,
    ),
    "handler",
  );
});

test("shortIdFromIdentity: malformed string returns input unchanged", () => {
  assert.equal(shortIdFromIdentity("plain-name" as SkillId), "plain-name");
});

// ─── toolNameOf ────────────────────────────────────────────────────────────

test("toolNameOf: returns shortId verbatim", () => {
  assert.equal(toolNameOf(echoSummary()), "echo");
  assert.equal(toolNameOf(echoSummary({ shortId: "with-hyphens_and_underscores" })),
    "with-hyphens_and_underscores",
  );
});

// ─── toInputSchema ─────────────────────────────────────────────────────────

test("toInputSchema: args without 'default' end up in required[]", () => {
  const schema = toInputSchema({
    a: { type: "string" },
    b: { type: "integer" },
  });
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      a: { type: "string" },
      b: { type: "integer" },
    },
    required: ["a", "b"],
    additionalProperties: false,
  });
});

test("toInputSchema: args with 'default' are optional (not in required[])", () => {
  const schema = toInputSchema({
    required: { type: "string" },
    optional: { type: "string", default: "x" },
  });
  assert.deepEqual((schema as { required: string[] }).required, ["required"]);
  const props = (schema as { properties: Record<string, unknown> }).properties;
  assert.ok("optional" in props, "optional must still appear in properties");
});

test("toInputSchema: fully optional args → no `required` key in result", () => {
  const schema = toInputSchema({
    only: { type: "string", default: "z" },
  });
  assert.ok(!("required" in schema), "required must be omitted when nothing required");
});

test("toInputSchema: empty args object → empty schema with no required", () => {
  const schema = toInputSchema({});
  assert.deepEqual(schema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

// ─── buildSystemParam ──────────────────────────────────────────────────────

test("buildSystemParam: useCache=true wraps in cache_control text block", () => {
  const result = buildSystemParam("you are a test agent", true);
  assert.deepEqual(result, [
    {
      type: "text",
      text: "you are a test agent",
      cache_control: { type: "ephemeral" },
    },
  ]);
});

test("buildSystemParam: useCache=false returns raw string", () => {
  const result = buildSystemParam("hello", false);
  assert.equal(result, "hello");
});

// ─── buildTools ────────────────────────────────────────────────────────────

test("buildTools: maps SkillSummary to Anthropic tool shape", () => {
  const tools = buildTools([echoSummary()], false);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "echo");
  assert.match(tools[0]!.description, /^Echo\n\nEchoes a message\n\nUse when:/);
  assert.deepEqual(tools[0]!.input_schema, {
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
    additionalProperties: false,
  });
  assert.ok(!tools[0]!.cache_control, "no cache_control when cacheLast=false");
});

test("buildTools: cacheLast=true sets cache_control on last tool only", () => {
  const tools = buildTools(
    [
      echoSummary({ shortId: "first" }),
      echoSummary({ shortId: "second" }),
      echoSummary({ shortId: "last" }),
    ],
    true,
  );
  assert.ok(!tools[0]!.cache_control);
  assert.ok(!tools[1]!.cache_control);
  assert.deepEqual(tools[2]!.cache_control, { type: "ephemeral" });
});

test("buildTools: cacheLast=true with single tool sets cache_control on it", () => {
  const tools = buildTools([echoSummary()], true);
  assert.deepEqual(tools[0]!.cache_control, { type: "ephemeral" });
});

test("buildTools: empty list returns empty array", () => {
  assert.deepEqual(buildTools([], true), []);
});

// ─── toolResultBlocks ──────────────────────────────────────────────────────

test("toolResultBlocks: ok result → tool_result with stdout, is_error:false", () => {
  const blocks = toolResultBlocks([
    {
      callId: "tu_1",
      result: {
        ok: true,
        command: "echo hi",
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        elapsedMs: 1,
        timedOut: false,
      },
    },
  ]);
  assert.deepEqual(blocks, [
    {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "hi\n",
      is_error: false,
    },
  ]);
});

test("toolResultBlocks: failure → uses stderr as content, is_error:true", () => {
  const blocks = toolResultBlocks([
    {
      callId: "tu_2",
      result: {
        ok: false,
        command: "false",
        stdout: "",
        stderr: "permission denied",
        exitCode: 1,
        elapsedMs: 1,
        timedOut: false,
      },
    },
  ]);
  assert.equal(blocks[0]!.content, "permission denied");
  assert.equal(blocks[0]!["is_error"], true);
});

test("toolResultBlocks: empty stdout AND stderr → content stays empty string", () => {
  const blocks = toolResultBlocks([
    {
      callId: "tu_3",
      result: {
        ok: true,
        command: ":",
        stdout: "",
        stderr: "",
        exitCode: 0,
        elapsedMs: 0,
        timedOut: false,
      },
    },
  ]);
  assert.equal(blocks[0]!.content, "");
});

// ─── buildMessages ─────────────────────────────────────────────────────────

test("buildMessages: empty history + pendingUser → single user message", () => {
  const msgs = buildMessages([], "hi", undefined);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.role, "user");
  assert.deepEqual(msgs[0]!.content, [{ type: "text", text: "hi" }]);
});

test("buildMessages: empty history + no pending → empty array", () => {
  const msgs = buildMessages([], undefined, undefined);
  assert.equal(msgs.length, 0);
});

test("buildMessages: history with text-only assistant turn", () => {
  const turn: Turn = {
    id: "t_1" as Turn["id"],
    ts: "2026-05-04T00:00:00Z",
    input: { user: "prior" },
    output: { text: "answer", toolCalls: [], stopReason: "end_turn" },
    approvals: [],
  };
  const msgs = buildMessages([turn], "next", undefined);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0]!.role, "user");
  assert.deepEqual(msgs[0]!.content, [{ type: "text", text: "prior" }]);
  assert.equal(msgs[1]!.role, "assistant");
  assert.deepEqual(msgs[1]!.content, [{ type: "text", text: "answer" }]);
  assert.equal(msgs[2]!.role, "user");
  assert.deepEqual(msgs[2]!.content, [{ type: "text", text: "next" }]);
});

test("buildMessages: assistant turn with tool_use blocks reconstructed", () => {
  const turn: Turn = {
    id: "t_1" as Turn["id"],
    ts: "2026-05-04T00:00:00Z",
    input: { user: "echo it" },
    output: {
      text: "I'll do that.",
      toolCalls: [
        { id: "tu_1", skillId: ECHO_ID, args: { msg: "x" } },
      ],
      stopReason: "tool_use",
    },
    approvals: [],
  };
  const msgs = buildMessages([turn], undefined, undefined);
  assert.equal(msgs[1]!.role, "assistant");
  const blocks = msgs[1]!.content;
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: "I'll do that." });
  assert.deepEqual(blocks[1], {
    type: "tool_use",
    id: "tu_1",
    name: "echo",          // shortIdFromIdentity → last path segment
    input: { msg: "x" },
  });
});

test("buildMessages: turn.input.toolResults emit tool_result blocks in user role", () => {
  const turn: Turn = {
    id: "t_2" as Turn["id"],
    ts: "2026-05-04T00:00:01Z",
    input: {
      toolResults: [
        {
          callId: "tu_1",
          result: {
            ok: true,
            command: "echo 'x'",
            stdout: "x\n",
            stderr: "",
            exitCode: 0,
            elapsedMs: 1,
            timedOut: false,
          },
        },
      ],
    },
    output: { text: "Done.", toolCalls: [], stopReason: "end_turn" },
    approvals: [],
  };
  const msgs = buildMessages([turn], undefined, undefined);
  assert.equal(msgs[0]!.role, "user");
  assert.equal(msgs[0]!.content[0]!.type, "tool_result");
  assert.equal(msgs[0]!.content[0]!["tool_use_id"], "tu_1");
});

test("buildMessages: pendingResults included as user blocks at end", () => {
  const msgs = buildMessages(
    [],
    undefined,
    [
      {
        callId: "tu_99",
        result: {
          ok: true,
          command: "x",
          stdout: "y",
          stderr: "",
          exitCode: 0,
          elapsedMs: 0,
          timedOut: false,
        },
      },
    ],
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.role, "user");
  assert.equal(msgs[0]!.content[0]!.type, "tool_result");
  assert.equal(msgs[0]!.content[0]!["tool_use_id"], "tu_99");
});

test("buildMessages: empty assistant turn (no text, no calls) is skipped", () => {
  const turn: Turn = {
    id: "t_3" as Turn["id"],
    ts: "2026-05-04T00:00:00Z",
    input: { user: "hi" },
    output: { text: "", toolCalls: [], stopReason: "end_turn" },
    approvals: [],
  };
  const msgs = buildMessages([turn], undefined, undefined);
  // user block from input.user, but no assistant block
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.role, "user");
});

// ─── mapStopReason ─────────────────────────────────────────────────────────

test("mapStopReason: known reasons map identity-style", () => {
  assert.equal(mapStopReason("end_turn"), "end_turn");
  assert.equal(mapStopReason("tool_use"), "tool_use");
  assert.equal(mapStopReason("max_tokens"), "max_tokens");
});

test("mapStopReason: null/undefined → end_turn (defensive default)", () => {
  assert.equal(mapStopReason(null), "end_turn");
  assert.equal(mapStopReason(undefined), "end_turn");
});

test("mapStopReason: unknown reason → error", () => {
  assert.equal(mapStopReason("future_reason"), "error");
  assert.equal(mapStopReason("pause_turn"), "error");
});

// ─── createAnthropicProvider — construction ────────────────────────────────

test("createAnthropicProvider: constructs without throwing on minimal opts", () => {
  const provider = createAnthropicProvider({
    apiKey: "fake-key-for-construction",
    model: "claude-opus-4-7",
    maxTokens: 1024,
  });
  assert.equal(typeof provider.turn, "function");
});

test("createAnthropicProvider: accepts fetchFn for testability", () => {
  const fetchMock: typeof fetch = async () => new Response("{}");
  const provider = createAnthropicProvider({
    apiKey: "fake",
    model: "claude-opus-4-7",
    maxTokens: 1024,
    fetchFn: fetchMock,
  });
  assert.equal(typeof provider.turn, "function");
});

test("createAnthropicProvider: fetch failure surfaces as stop:error event", async () => {
  // Stub the SDK's fetch to throw immediately. The provider should NOT
  // re-throw — it must surface the failure as a TurnEvent.
  const fetchMock: typeof fetch = async () => {
    throw new Error("ECONNREFUSED simulated");
  };
  const provider: Provider = createAnthropicProvider({
    apiKey: "fake",
    model: "claude-opus-4-7",
    maxTokens: 64,
    fetchFn: fetchMock,
    promptCaching: false,
  });

  const minimalInput: TurnInput = {
    systemPrompt: "system",
    history: [],
    user: "hi",
    availableTools: [],
  };

  const events: TurnEvent[] = [];
  for await (const evt of provider.turn(minimalInput)) {
    events.push(evt);
    if (events.length >= 5) break;
  }

  // Provider may yield error events at construction time (synchronous failure)
  // or during stream iteration — either way at least one stop:error is emitted.
  const stopEvents = events.filter(
    (e): e is Extract<TurnEvent, { type: "stop" }> => e.type === "stop",
  );
  assert.ok(
    stopEvents.some((e) => e.reason === "error"),
    `expected at least one stop:error in: ${JSON.stringify(events)}`,
  );
});
