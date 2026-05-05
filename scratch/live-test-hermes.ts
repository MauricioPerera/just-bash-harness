// Hermes provider smoke: replay the EXACT SSE stream we captured via the
// MCP connector for hermes-2-pro-mistral-7b and assert the provider
// synthesizes a tool_call event from the <tool_call> tags in delta.content.

import { createCloudflareProvider } from "../src/provider-cloudflare.js";
import type {
  Provider,
  SkillId,
  SkillSummary,
  TurnEvent,
  TurnInput,
} from "../src/types.js";

const ECHO_ID =
  "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/base64-encode" as SkillId;

const tools: SkillSummary[] = [
  {
    id: ECHO_ID,
    shortId: "base64-encode",
    title: "Base64 encode",
    description: "Base64 encode a string",
    use_when: "to encode a string to base64",
    pack: "github.com/test/pack",
    version: "1.0.0",
    signatureStatus: "valid",
    network: [],
    filesystem: [],
    idempotent: true,
    args: { value: { type: "string" } },
  },
];

const input: TurnInput = {
  systemPrompt: "test",
  history: [],
  user: "encode hello",
  availableTools: tools,
};

// Real captured SSE stream from a live MCP call to hermes-2-pro-mistral-7b
// via the OpenAI-compat endpoint. Each chunk is split as the model
// originally streamed it.
const HERMES_STREAM_CHUNKS = [
  `data: {"choices":[{"index":0,"delta":{"content":"<"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"tool"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"_"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"call"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":">"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"\\n"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"{'"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"arguments"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"':"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":" {'"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"value"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"':"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":" '"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"'},"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":" '"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"name"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"':"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":" '"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"base"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"6"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"4"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"-"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"encode"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"'}"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"\\n"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"</"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"tool"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"_"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":"call"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{"content":">"}}]}\n\n`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  `data: [DONE]\n\n`,
];

const sseResponse = (chunks: readonly string[]): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};

const main = async (): Promise<void> => {
  const provider: Provider = createCloudflareProvider({
    accountId: "x",
    apiToken: "y",
    model: "@hf/nousresearch/hermes-2-pro-mistral-7b",
    fetchFn: async () => sseResponse(HERMES_STREAM_CHUNKS),
  });

  const events: TurnEvent[] = [];
  for await (const e of provider.turn(input)) events.push(e);

  console.log("=".repeat(72));
  console.log("HERMES SMOKE — replayed real SSE stream from live MCP capture");
  console.log("=".repeat(72));
  console.log(`captured ${events.length} events`);
  for (const e of events) {
    console.log(`  ${e.type}: ${JSON.stringify(e).slice(0, 100)}`);
  }
  console.log("");

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

  const toolCalls = events.filter(
    (e): e is Extract<TurnEvent, { type: "tool_call" }> => e.type === "tool_call",
  );
  const stops = events.filter(
    (e): e is Extract<TurnEvent, { type: "stop" }> => e.type === "stop",
  );
  const texts = events.filter(
    (e): e is Extract<TurnEvent, { type: "text" }> => e.type === "text",
  );
  const totalTextEmitted = texts.map((e) => e.delta).join("");

  check(
    "exactly one tool_call event synthesized from <tool_call> tags",
    toolCalls.length === 1,
    `got ${toolCalls.length}`,
  );
  if (toolCalls.length === 1) {
    check(
      "tool_call.skill mapped to full SkillId via name lookup",
      toolCalls[0]!.skill === ECHO_ID,
      `got ${toolCalls[0]!.skill}`,
    );
    check(
      "tool_call.args parsed correctly (Python-repr → JS object)",
      JSON.stringify(toolCalls[0]!.args) === JSON.stringify({ value: "hello" }),
      `got ${JSON.stringify(toolCalls[0]!.args)}`,
    );
  }
  check(
    "raw <tool_call> markup NOT visible in text events",
    !totalTextEmitted.includes("<tool_call>") &&
      !totalTextEmitted.includes("</tool_call>"),
    `text was: ${JSON.stringify(totalTextEmitted)}`,
  );
  check(
    "stop reason overridden from 'stop' (Hermes) to 'tool_use' since we synthesized a tool_call",
    stops[stops.length - 1]?.reason === "tool_use",
    `last stop: ${JSON.stringify(stops[stops.length - 1])}`,
  );

  console.log("");
  console.log(`${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("hermes smoke crashed:", err);
  process.exit(2);
});
