// LLM provider — Cloudflare Workers AI via OpenAI-compatible endpoint.
//
// Default model: @cf/google/gemma-4-26b-a4b-it (256K context, function
// calling supported per Cloudflare model card).
//
// Endpoint:
//   POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1/chat/completions
// Auth:
//   Authorization: Bearer <api_token>
//
// We hand-roll fetch + SSE parsing to avoid taking on the `openai` SDK dep
// just for one model. The format is small enough.

import type {
  Provider,
  SkillId,
  SkillSummary,
  StopReason,
  ToolCallResult,
  Turn,
  TurnEvent,
  TurnInput,
} from "./types.js";

const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

export interface CloudflareProviderOpts {
  accountId: string;
  apiToken: string;
  /** Defaults to @cf/google/gemma-4-26b-a4b-it. */
  model?: string;
  /** Maps to OpenAI `max_completion_tokens`. */
  maxTokens?: number;
  /** 0–2 per Cloudflare docs. */
  temperature?: number;
  /** Override base URL (testing). */
  baseUrl?: string;
  /** Inject fetch (testing). */
  fetchFn?: typeof fetch;
}

// ─── shape adapters ─────────────────────────────────────────────────────────

const shortIdFromIdentity = (id: SkillId): string => {
  const m = id.match(/\/([^/@]+)$/);
  return m?.[1] ?? id;
};

const toInputSchema = (args: Record<string, unknown>): Record<string, unknown> => {
  const required: string[] = [];
  for (const [name, spec] of Object.entries(args)) {
    if (spec && typeof spec === "object" && !("default" in (spec as object))) {
      required.push(name);
    }
  }
  return {
    type: "object",
    properties: args,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
};

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const buildTools = (skills: readonly SkillSummary[]): OpenAITool[] =>
  skills.map((s) => ({
    type: "function",
    function: {
      name: s.shortId,
      description: `${s.title}\n\n${s.description}\n\nUse when: ${s.use_when}`,
      parameters: toInputSchema(s.args),
    },
  }));

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

const toolResultsToMessages = (results: readonly ToolCallResult[]): OpenAIMessage[] =>
  results.map((r) => ({
    role: "tool",
    tool_call_id: r.callId,
    content: r.result.stdout || r.result.stderr || "",
  }));

const buildMessages = (input: TurnInput): OpenAIMessage[] => {
  const msgs: OpenAIMessage[] = [
    { role: "system", content: input.systemPrompt },
  ];

  for (const turn of input.history) {
    if (turn.input.user) msgs.push({ role: "user", content: turn.input.user });
    if (turn.input.toolResults && turn.input.toolResults.length > 0) {
      msgs.push(...toolResultsToMessages(turn.input.toolResults));
    }

    const hasText = turn.output.text.length > 0;
    const hasCalls = turn.output.toolCalls.length > 0;
    if (hasText || hasCalls) {
      const assistant: OpenAIMessage = {
        role: "assistant",
        content: hasText ? turn.output.text : null,
        ...(hasCalls
          ? {
              tool_calls: turn.output.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                  name: shortIdFromIdentity(tc.skillId),
                  arguments: JSON.stringify(tc.args),
                },
              })),
            }
          : {}),
      };
      msgs.push(assistant);
    }
  }

  if (input.user !== undefined) {
    msgs.push({ role: "user", content: input.user });
  }
  if (input.toolResults && input.toolResults.length > 0) {
    msgs.push(...toolResultsToMessages(input.toolResults));
  }

  return msgs;
};

// ─── stream handling ────────────────────────────────────────────────────────

interface OpenAIStreamChunk {
  choices: Array<{
    index: number;
    delta?: {
      content?: string;
      /** Gemma 4 26B is a reasoning model; CF surfaces chain-of-thought
       *  here. Mapped to TurnEvent.thinking so the harness can render
       *  it on stderr without conflating with normal output. */
      reasoning?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
      role?: string;
    };
    finish_reason?: string | null;
  }>;
}

const mapFinishReason = (raw: string | null | undefined): StopReason => {
  switch (raw) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case null:
    case undefined:
      return "end_turn";
    default:
      return "error";
  }
};

// ─── Hermes-style tool_call parsing ────────────────────────────────────────
// Some Workers AI models (Hermes 2 Pro and similar) emit tool calls inline
// in `delta.content` instead of `delta.tool_calls`, wrapped in <tool_call>
// XML-like tags with Python-repr-style content:
//
//   <tool_call>
//   {'arguments': {'value': 'hello'}, 'name': 'base64-encode'}
//   </tool_call>
//
// We need to detect these blocks across chunked deltas, suppress the raw
// markup from text events, and emit proper tool_call events.

const TAG_OPEN = "<tool_call>";
const TAG_CLOSE = "</tool_call>";

interface HermesToolCall {
  name: string;
  args: unknown;
}

/** Parse a Python-repr-ish dict (single-quoted) into a JS object. Best
 *  effort: replaces single quotes with double quotes and JSON.parse's.
 *  Returns null on failure. */
const parseHermesPayload = (raw: string): HermesToolCall | null => {
  // Trim whitespace and any newlines.
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Naive single→double quote swap. Falls over if a value contains a literal
  // single quote, but Hermes 2 Pro tends to escape those as \\' or use double
  // quotes in user-provided strings, so this is acceptable for v1.
  const jsonish = trimmed.replace(/'/g, '"');
  try {
    const obj = JSON.parse(jsonish) as Record<string, unknown>;
    const name = typeof obj["name"] === "string" ? obj["name"] : null;
    if (name === null) return null;
    const args = obj["arguments"] ?? {};
    return { name, args };
  } catch {
    return null;
  }
};

interface BufferProcessOutput {
  textToEmit: string;        // content safe to yield as `text` deltas
  toolCalls: HermesToolCall[]; // complete <tool_call> blocks parsed out
  remaining: string;          // partial tag tail to keep in buffer
  parseFailures: string[];    // raw inner content of <tool_call> blocks that failed to parse
}

/** Process a content buffer, splitting it into safe-to-emit text, fully-
 *  closed <tool_call> blocks, and a tail that may be a partial tag. */
const processHermesBuffer = (buffer: string): BufferProcessOutput => {
  const toolCalls: HermesToolCall[] = [];
  const parseFailures: string[] = [];
  const textParts: string[] = [];
  let remaining = buffer;

  while (true) {
    const openIdx = remaining.indexOf(TAG_OPEN);
    if (openIdx === -1) break;

    // Text before the tag is safe to emit.
    if (openIdx > 0) textParts.push(remaining.slice(0, openIdx));

    const afterOpen = remaining.slice(openIdx + TAG_OPEN.length);
    const closeIdx = afterOpen.indexOf(TAG_CLOSE);
    if (closeIdx === -1) {
      // Open without close — wait for more content. Keep from openIdx onward.
      remaining = remaining.slice(openIdx);
      // Return now; the partial open is in `remaining`.
      return { textToEmit: textParts.join(""), toolCalls, remaining, parseFailures };
    }

    const inner = afterOpen.slice(0, closeIdx);
    const parsed = parseHermesPayload(inner);
    if (parsed !== null) {
      toolCalls.push(parsed);
    } else {
      // Couldn't parse — surface the raw markup as text so the failure is
      // at least visible, AND record the inner content so the caller can
      // emit a diagnostic (thinking) event for debugging.
      textParts.push(`${TAG_OPEN}${inner}${TAG_CLOSE}`);
      parseFailures.push(inner);
    }
    remaining = afterOpen.slice(closeIdx + TAG_CLOSE.length);
  }

  // No more open tags. Check if `remaining` ends with a possible partial
  // tag prefix (e.g. "<", "<tool_cal"). If so, hold that suffix back.
  // Only suffixes starting with "<" can be partial-tag candidates (TAG_OPEN
  // starts with "<"), so the redundant `suffix === TAG_OPEN.slice(0, i) &&
  // suffix.startsWith("<")` check from earlier versions is folded into the
  // single TAG_OPEN.startsWith(suffix) test below.
  for (let i = 1; i <= TAG_OPEN.length; i++) {
    const suffix = remaining.slice(-i);
    if (suffix.length === i && TAG_OPEN.startsWith(suffix)) {
      textParts.push(remaining.slice(0, remaining.length - i));
      return {
        textToEmit: textParts.join(""),
        toolCalls,
        remaining: suffix,
        parseFailures,
      };
    }
  }

  textParts.push(remaining);
  return { textToEmit: textParts.join(""), toolCalls, remaining: "", parseFailures };
};

// Exported for unit tests.
export const __test_processHermesBuffer = processHermesBuffer;
export const __test_parseHermesPayload = parseHermesPayload;

// ─── public factory ─────────────────────────────────────────────────────────

export const createCloudflareProvider = (
  opts: CloudflareProviderOpts,
): Provider => {
  if (!opts.accountId || !opts.apiToken) {
    throw new Error("createCloudflareProvider: accountId + apiToken required");
  }
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchFn ?? globalThis.fetch;

  return {
    async *turn(input: TurnInput, signal?: AbortSignal): AsyncIterable<TurnEvent> {
      const nameToId = new Map<string, SkillId>();
      for (const s of input.availableTools) nameToId.set(s.shortId, s.id);

      const messages = buildMessages(input);
      const tools = buildTools(input.availableTools);

      const url = `${baseUrl}/accounts/${opts.accountId}/ai/v1/chat/completions`;
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        max_completion_tokens: opts.maxTokens ?? 8000,
      };
      if (tools.length > 0) body["tools"] = tools;
      if (opts.temperature !== undefined) body["temperature"] = opts.temperature;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          // Propagate abort so Ctrl+C in the harness actually closes the
          // upstream HTTP request instead of letting it drain. Browsers
          // and Node 22 both honor this through to the underlying socket.
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (err) {
        yield { type: "stop", reason: "error" };
        yield {
          type: "text",
          delta: `\ncloudflare fetch failed: ${(err as Error).message}`,
        };
        return;
      }

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        yield { type: "stop", reason: "error" };
        yield {
          type: "text",
          delta: `\ncloudflare ${response.status}: ${text.slice(0, 500)}`,
        };
        return;
      }

      // Parse SSE: lines `data: <json>\n`, terminated by `data: [DONE]`.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const partialArgs = new Map<number, string>();
      const partialMeta = new Map<number, { id: string; name: string }>();
      let finishReason: StopReason = "end_turn";

      // Hermes-style content-channel tool_call detection. Models like
      // hermes-2-pro emit <tool_call>{...}</tool_call> inside delta.content
      // instead of populating delta.tool_calls. We accumulate content
      // across chunks and emit synthesized tool_call events when complete
      // blocks are seen.
      let hermesContentBuffer = "";
      let hermesToolCallCounter = 0;
      let hermesEmittedCount = 0;
      const emitHermesToolCalls = function* (parsed: HermesToolCall[]): Generator<TurnEvent> {
        for (const p of parsed) {
          hermesToolCallCounter++;
          const fullId = nameToId.get(p.name);
          yield {
            type: "tool_call",
            id: `hermes-tool-${hermesToolCallCounter}`,
            skill: (fullId ?? p.name) as SkillId,
            args: p.args,
          };
          hermesEmittedCount++;
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // Normalize CRLF + split on LF.
          buf = buf.replace(/\r\n/g, "\n");
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
            if (line.length === 0) continue;
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;

            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(payload) as OpenAIStreamChunk;
            } catch {
              continue;
            }

            const choice = chunk.choices[0];
            if (!choice) continue;
            const delta = choice.delta;

            if (delta?.content) {
              // Route through the Hermes-aware processor. For models that
              // don't use the <tool_call> convention, every char is plain
              // text and this is effectively pass-through. For Hermes,
              // tag content is suppressed and emitted as tool_call events.
              hermesContentBuffer += delta.content;
              const out = processHermesBuffer(hermesContentBuffer);
              hermesContentBuffer = out.remaining;
              if (out.textToEmit.length > 0) {
                yield { type: "text", delta: out.textToEmit };
              }
              for (const raw of out.parseFailures) {
                yield {
                  type: "thinking",
                  delta: `[hermes parser: failed to parse <tool_call> payload (${raw.length} chars); raw markup surfaced as text]\n`,
                };
              }
              yield* emitHermesToolCalls(out.toolCalls);
            }
            if (delta?.reasoning) {
              yield { type: "thinking", delta: delta.reasoning };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                const prevMeta = partialMeta.get(idx);
                const id = tc.id ?? prevMeta?.id ?? "";
                const name = tc.function?.name ?? prevMeta?.name ?? "";
                if (id || name) {
                  partialMeta.set(idx, { id, name });
                }
                if (tc.function?.arguments !== undefined) {
                  const prev = partialArgs.get(idx) ?? "";
                  partialArgs.set(idx, prev + tc.function.arguments);
                }
              }
            }
            if (
              choice.finish_reason !== undefined &&
              choice.finish_reason !== null
            ) {
              finishReason = mapFinishReason(choice.finish_reason);
            }
          }
        }

        // Flush any remaining Hermes content buffer. If it still contains
        // a partial unfinished <tool_call> tag, surface as text so the
        // failure is visible.
        if (hermesContentBuffer.length > 0) {
          const tail = processHermesBuffer(hermesContentBuffer);
          if (tail.textToEmit.length > 0) {
            yield { type: "text", delta: tail.textToEmit };
          }
          for (const raw of tail.parseFailures) {
            yield {
              type: "thinking",
              delta: `[hermes parser: failed to parse <tool_call> payload (${raw.length} chars); raw markup surfaced as text]\n`,
            };
          }
          yield* emitHermesToolCalls(tail.toolCalls);
          if (tail.remaining.length > 0) {
            // Unterminated <tool_call> — emit as text so the user sees it,
            // and report it as a parse failure for visibility.
            yield { type: "text", delta: tail.remaining };
            yield {
              type: "thinking",
              delta: `[hermes parser: stream ended with unterminated <tool_call> tag (${tail.remaining.length} chars)]\n`,
            };
          }
        }

        // Flush buffered openai-style tool calls in stable order.
        const sortedIndices = Array.from(partialMeta.keys()).sort((a, b) => a - b);
        for (const idx of sortedIndices) {
          const meta = partialMeta.get(idx);
          if (!meta) continue;
          const raw = partialArgs.get(idx) ?? "";
          let parsed: unknown = {};
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = { __parse_error: raw };
            }
          }
          const fullId = nameToId.get(meta.name);
          yield {
            type: "tool_call",
            id: meta.id,
            skill: (fullId ?? meta.name) as SkillId,
            args: parsed,
          };
        }

        // Hermes responds with finish_reason: "stop" even when it emitted
        // tool calls in content. If we synthesized any, override to tool_use
        // so the loop knows to feed back tool_results.
        if (hermesEmittedCount > 0 && finishReason === "end_turn") {
          finishReason = "tool_use";
        }

        yield { type: "stop", reason: finishReason };
      } catch (err) {
        yield {
          type: "text",
          delta: `\nstream error: ${(err as Error).message}`,
        };
        yield { type: "stop", reason: "error" };
      }
    },
  };
};

export type { Provider };

// `Turn` import kept for build correctness when the file is consumed standalone.
export type _UsedTurn = Turn;
