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
    async *turn(input: TurnInput): AsyncIterable<TurnEvent> {
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
              yield { type: "text", delta: delta.content };
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

        // Flush buffered tool calls in stable order.
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
