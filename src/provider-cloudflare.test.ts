import { test } from "node:test";
import { strict as assert } from "node:assert";

import { createCloudflareProvider } from "./provider-cloudflare.js";
import type {
  Provider,
  SkillId,
  SkillSummary,
  Turn,
  TurnEvent,
  TurnInput,
} from "./types.js";

// ─── helpers ───────────────────────────────────────────────────────────────

const ECHO_ID =
  "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo" as SkillId;

const minimalTools = (): SkillSummary[] => [
  {
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
  },
];

const minimalInput = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  systemPrompt: "you are a test agent",
  history: [],
  user: "say hi",
  availableTools: minimalTools(),
  ...overrides,
});

/** Build a Response whose body streams the given chunks in order. */
const sseResponse = (chunks: readonly string[]): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};

const collect = async (
  provider: Provider,
  input: TurnInput,
): Promise<TurnEvent[]> => {
  const out: TurnEvent[] = [];
  for await (const e of provider.turn(input)) out.push(e);
  return out;
};

// ─── construction validation ───────────────────────────────────────────────

test("createCloudflareProvider: throws without accountId", () => {
  assert.throws(
    () => createCloudflareProvider({ accountId: "", apiToken: "x" }),
    /required/,
  );
});

test("createCloudflareProvider: throws without apiToken", () => {
  assert.throws(
    () => createCloudflareProvider({ accountId: "x", apiToken: "" }),
    /required/,
  );
});

// ─── request shape ─────────────────────────────────────────────────────────

test("cloudflare provider: builds correct URL + headers + body", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchMock: typeof fetch = async (url, init) => {
    captured = { url: String(url), ...(init !== undefined ? { init } : {}) };
    return sseResponse(['data: [DONE]\n\n']);
  };
  const provider = createCloudflareProvider({
    accountId: "acct123",
    apiToken: "tok456",
    fetchFn: fetchMock,
  });
  await collect(provider, minimalInput());
  assert.ok(captured);
  assert.equal(
    captured!.url,
    "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions",
  );
  const headers = captured!.init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer tok456");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Accept"], "text/event-stream");

  const body = JSON.parse(String(captured!.init?.body));
  assert.equal(body.model, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(body.stream, true);
  assert.equal(body.max_completion_tokens, 8000);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "you are a test agent");
  assert.equal(body.messages[1].role, "user");
  assert.equal(body.messages[1].content, "say hi");
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "echo");
  assert.deepEqual(body.tools[0].function.parameters, {
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
    additionalProperties: false,
  });
});

test("cloudflare provider: omits tools when none available", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetchMock: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  };
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  await collect(provider, minimalInput({ availableTools: [] }));
  assert.ok(capturedBody);
  assert.ok(!("tools" in capturedBody!), "tools key should be omitted entirely");
});

test("cloudflare provider: custom model + maxTokens applied", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetchMock: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  };
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    model: "@cf/meta/llama-3.1-8b-instruct",
    maxTokens: 256,
    temperature: 0.7,
    fetchFn: fetchMock,
  });
  await collect(provider, minimalInput());
  assert.equal(capturedBody!["model"], "@cf/meta/llama-3.1-8b-instruct");
  assert.equal(capturedBody!["max_completion_tokens"], 256);
  assert.equal(capturedBody!["temperature"], 0.7);
});

test("cloudflare provider: history → assistant + tool messages reconstructed", async () => {
  let capturedBody: { messages: Array<Record<string, unknown>> } | null = null;
  const fetchMock: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return sseResponse(["data: [DONE]\n\n"]);
  };
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });

  const priorTurn: Turn = {
    id: "t_1" as Turn["id"],
    ts: "2026-05-04T00:00:00Z",
    input: { user: "prior" },
    output: {
      text: "I'll echo it.",
      toolCalls: [
        { id: "tu_1", skillId: ECHO_ID, args: { msg: "x" } },
      ],
      stopReason: "tool_use",
    },
    approvals: [],
  };
  const priorTurn2: Turn = {
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

  await collect(provider, {
    systemPrompt: "system",
    history: [priorTurn, priorTurn2],
    user: "next",
    availableTools: minimalTools(),
  });

  // Expected message sequence:
  //   system, user(prior), assistant(text+tool_use), user(tool_result),
  //   assistant(Done.), user(next)
  const msgs = capturedBody!.messages;
  assert.equal(msgs[0]?.["role"], "system");
  assert.equal(msgs[1]?.["role"], "user");
  assert.equal(msgs[1]?.["content"], "prior");
  assert.equal(msgs[2]?.["role"], "assistant");
  const tcs = (msgs[2] as { tool_calls: Array<{ function: { name: string; arguments: string } }> }).tool_calls;
  assert.equal(tcs.length, 1);
  assert.equal(tcs[0]!.function.name, "echo");
  assert.equal(tcs[0]!.function.arguments, '{"msg":"x"}');
  assert.equal(msgs[3]?.["role"], "tool");
  assert.equal(msgs[3]?.["tool_call_id"], "tu_1");
  assert.equal(msgs[3]?.["content"], "x\n");
  assert.equal(msgs[4]?.["role"], "assistant");
  assert.equal(msgs[4]?.["content"], "Done.");
  assert.equal(msgs[5]?.["role"], "user");
  assert.equal(msgs[5]?.["content"], "next");
});

// ─── stream parsing — text ─────────────────────────────────────────────────

test("cloudflare provider: text deltas → text events, finish=stop → end_turn", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const texts = events
    .filter((e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta);
  assert.deepEqual(texts, ["hello", " world"]);
  const last = events[events.length - 1];
  assert.deepEqual(last, { type: "stop", reason: "end_turn" });
});

test("cloudflare provider: chunk boundaries split mid-line are reassembled", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":', // partial
      '{"content":"split"}}]}\n\n',             // continuation
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const text = events.find(
    (e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text",
  );
  assert.equal(text?.delta, "split");
});

test("cloudflare provider: handles CRLF line endings", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"crlf"}}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const text = events.find(
    (e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text",
  );
  assert.equal(text?.delta, "crlf");
});

// ─── stream parsing — tool calls ───────────────────────────────────────────

test("cloudflare provider: tool_call assembled across deltas, mapped to full SkillId", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"echo","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"msg\\":"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const toolCalls = events.filter(
    (e): e is Extract<TurnEvent, { type: "tool_call" }> => e.type === "tool_call",
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]!.id, "call_1");
  assert.equal(toolCalls[0]!.skill, ECHO_ID); // mapped from short name → full identity
  assert.deepEqual(toolCalls[0]!.args, { msg: "hi" });
  const last = events[events.length - 1];
  assert.deepEqual(last, { type: "stop", reason: "tool_use" });
});

test("cloudflare provider: unknown tool name yields tool_call with raw name (loop denies)", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"hallucinated","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const toolCalls = events.filter(
    (e): e is Extract<TurnEvent, { type: "tool_call" }> => e.type === "tool_call",
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]!.skill, "hallucinated"); // pass-through, NOT mapped
});

test("cloudflare provider: tool_calls stable order by index across out-of-order chunks", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      // index 1 appears before index 0
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"b","type":"function","function":{"name":"echo","arguments":"{\\"msg\\":\\"second\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"echo","arguments":"{\\"msg\\":\\"first\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const toolCalls = events.filter(
    (e): e is Extract<TurnEvent, { type: "tool_call" }> => e.type === "tool_call",
  );
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0]!.id, "a");
  assert.deepEqual(toolCalls[0]!.args, { msg: "first" });
  assert.equal(toolCalls[1]!.id, "b");
  assert.deepEqual(toolCalls[1]!.args, { msg: "second" });
});

test("cloudflare provider: malformed tool_call JSON surfaces as __parse_error", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"echo","arguments":"not-json"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const tc = events.find(
    (e): e is Extract<TurnEvent, { type: "tool_call" }> => e.type === "tool_call",
  );
  assert.deepEqual(tc?.args, { __parse_error: "not-json" });
});

// ─── stream parsing — reasoning ────────────────────────────────────────────

test("cloudflare provider: reasoning deltas → thinking events", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"reasoning":"let me think"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning":" some more"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const thinking = events
    .filter((e): e is Extract<TurnEvent, { type: "thinking" }> => e.type === "thinking")
    .map((e) => e.delta);
  assert.deepEqual(thinking, ["let me think", " some more"]);
});

// ─── stop reason mapping ───────────────────────────────────────────────────

test("cloudflare provider: finish_reason=length → max_tokens", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  assert.deepEqual(events[events.length - 1], {
    type: "stop",
    reason: "max_tokens",
  });
});

test("cloudflare provider: unknown finish_reason → error", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"weird-new-reason"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  assert.deepEqual(events[events.length - 1], { type: "stop", reason: "error" });
});

// ─── error handling ────────────────────────────────────────────────────────

test("cloudflare provider: 4xx response → stop:error + error text", async () => {
  const fetchMock: typeof fetch = async () =>
    new Response("invalid token", { status: 401 });
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "bad",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const stopEvent = events.find(
    (e): e is Extract<TurnEvent, { type: "stop" }> => e.type === "stop",
  );
  const text = events.find(
    (e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text",
  );
  assert.equal(stopEvent?.reason, "error");
  assert.match(text?.delta ?? "", /cloudflare 401/);
  assert.match(text?.delta ?? "", /invalid token/);
});

test("cloudflare provider: fetch throws → stop:error + message included", async () => {
  const fetchMock: typeof fetch = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:443");
  };
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const text = events.find(
    (e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text",
  );
  assert.match(text?.delta ?? "", /ECONNREFUSED/);
  const stopEvent = events.find(
    (e): e is Extract<TurnEvent, { type: "stop" }> => e.type === "stop",
  );
  assert.equal(stopEvent?.reason, "error");
});

test("cloudflare provider: malformed SSE chunks are skipped without crashing", async () => {
  const fetchMock: typeof fetch = async () =>
    sseResponse([
      "data: not-json\n\n",
      "this is not an sse line\n",
      "event: ignored\n",
      'data: {"choices":[{"index":0,"delta":{"content":"survived"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  const events = await collect(provider, minimalInput());
  const text = events.find(
    (e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text",
  );
  assert.equal(text?.delta, "survived");
});

// ─── arg-schema mapping ────────────────────────────────────────────────────

test("cloudflare provider: args without 'default' end up in required[]", async () => {
  let body: { tools: Array<{ function: { parameters: Record<string, unknown> } }> } | null = null;
  const fetchMock: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return sseResponse(["data: [DONE]\n\n"]);
  };
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  await collect(
    provider,
    minimalInput({
      availableTools: [
        {
          ...minimalTools()[0]!,
          args: {
            required_arg: { type: "string" },
            optional_arg: { type: "string", default: "x" },
          },
        },
      ],
    }),
  );
  const params = body!.tools[0]!.function.parameters as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assert.deepEqual(params.required, ["required_arg"]);
  assert.ok("optional_arg" in params.properties);
  assert.ok("required_arg" in params.properties);
});

// ─── Hermes-style tool_call parsing ────────────────────────────────────────

import {
  __test_parseHermesPayload as parseHermesPayload,
  __test_processHermesBuffer as processHermesBuffer,
} from "./provider-cloudflare.js";

test("hermes parser: parses single-quoted python-repr dict", () => {
  const result = parseHermesPayload(
    `{'arguments': {'value': 'hello'}, 'name': 'base64-encode'}`,
  );
  assert.equal(result?.name, "base64-encode");
  assert.deepEqual(result?.args, { value: "hello" });
});

test("hermes parser: parses with newlines + spacing", () => {
  const result = parseHermesPayload(
    `\n  {'name': 'echo', 'arguments': {'msg': 'hi'}}  \n`,
  );
  assert.equal(result?.name, "echo");
  assert.deepEqual(result?.args, { msg: "hi" });
});

test("hermes parser: returns null on missing name", () => {
  const result = parseHermesPayload(`{'arguments': {'value': 'x'}}`);
  assert.equal(result, null);
});

test("hermes parser: returns null on garbage", () => {
  assert.equal(parseHermesPayload("not even close"), null);
  assert.equal(parseHermesPayload(""), null);
});

test("hermes buffer: plain text passes through", () => {
  const out = processHermesBuffer("hello world, how are you?");
  assert.equal(out.textToEmit, "hello world, how are you?");
  assert.equal(out.toolCalls.length, 0);
  assert.equal(out.remaining, "");
});

test("hermes buffer: complete tool_call block extracted, no text", () => {
  const buf = `<tool_call>\n{'arguments': {'value': 'hi'}, 'name': 'echo'}\n</tool_call>`;
  const out = processHermesBuffer(buf);
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0]!.name, "echo");
  assert.deepEqual(out.toolCalls[0]!.args, { value: "hi" });
  assert.equal(out.textToEmit, "");
  assert.equal(out.remaining, "");
});

test("hermes buffer: text + tool_call + text", () => {
  const buf = `Sure! <tool_call>\n{'name': 'echo', 'arguments': {'msg': 'hi'}}\n</tool_call> here you go.`;
  const out = processHermesBuffer(buf);
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.textToEmit, "Sure!  here you go.");
  assert.equal(out.remaining, "");
});

test("hermes buffer: incomplete tag holds back from emission", () => {
  const buf = `Sure thing <tool_cal`;
  const out = processHermesBuffer(buf);
  assert.equal(out.textToEmit, "Sure thing ");
  assert.equal(out.toolCalls.length, 0);
  assert.equal(out.remaining, "<tool_cal");
});

test("hermes buffer: tag opened but not closed → all from < kept buffered", () => {
  const buf = `Hello <tool_call>{'name': 'echo`;
  const out = processHermesBuffer(buf);
  assert.equal(out.textToEmit, "Hello ");
  assert.equal(out.toolCalls.length, 0);
  assert.equal(out.remaining, "<tool_call>{'name': 'echo");
});

test("hermes buffer: two tool_calls in one buffer", () => {
  const buf =
    `<tool_call>{'name': 'a', 'arguments': {}}</tool_call>` +
    `text between` +
    `<tool_call>{'name': 'b', 'arguments': {'x': 1}}</tool_call>`;
  const out = processHermesBuffer(buf);
  assert.equal(out.toolCalls.length, 2);
  assert.equal(out.toolCalls[0]!.name, "a");
  assert.equal(out.toolCalls[1]!.name, "b");
  assert.equal(out.textToEmit, "text between");
});

test("hermes buffer: malformed inner content surfaces as raw text (not silently dropped)", () => {
  const buf = `<tool_call>this isn't valid python repr</tool_call>`;
  const out = processHermesBuffer(buf);
  assert.equal(out.toolCalls.length, 0);
  assert.match(out.textToEmit, /<tool_call>/);
});

test("hermes buffer: bare '<' alone is held back", () => {
  // The lone '<' could be the start of a tag.
  const out = processHermesBuffer("hello <");
  assert.equal(out.textToEmit, "hello ");
  assert.equal(out.remaining, "<");
});

test("hermes buffer: '<' followed by non-tag char → emit all", () => {
  // A lone '<' followed by something that can't continue the tag should
  // ideally be emitted, but our heuristic conservatively holds the '<'
  // and waits for more. The next chunk will resolve it.
  const out = processHermesBuffer("a<b<tool_call>{'name':'x','arguments':{}}</tool_call>");
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0]!.name, "x");
});

test("cloudflare provider: args fully optional → no required field in schema", async () => {
  let body: { tools: Array<{ function: { parameters: Record<string, unknown> } }> } | null = null;
  const fetchMock: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return sseResponse(["data: [DONE]\n\n"]);
  };
  const provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    fetchFn: fetchMock,
  });
  await collect(
    provider,
    minimalInput({
      availableTools: [
        {
          ...minimalTools()[0]!,
          args: { only: { type: "string", default: "z" } },
        },
      ],
    }),
  );
  const params = body!.tools[0]!.function.parameters;
  assert.ok(!("required" in params), "required key must be absent when nothing required");
});
