// LLM provider adapter. v0: Anthropic only. The interface (Provider) is
// pluggable so a second adapter is additive.
//
// What this does:
//   - Maps TurnInput → Anthropic Messages API request (system + tools + messages).
//   - Translates streaming events → our TurnEvent shape.
//   - Adds prompt-caching breakpoints on system + last tool (stable surfaces).
//   - Optionally enables extended thinking.
//
// What it does NOT do (per DESIGN §2 trust):
//   - Re-interpret tool stdout as instructions.
//   - Trust LLM-claimed approvals — that lives in approval.ts / loop.ts.

import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  SkillSummary,
  StopReason,
  TurnEvent,
  TurnInput,
  Turn,
  ToolCallResult,
  SkillId,
} from "./types.js";

export interface AnthropicProviderOpts {
  apiKey: string;
  model: string;             // e.g. "claude-opus-4-7" or "claude-sonnet-4-6"
  maxTokens: number;
  /** Enable cache_control on system + last tool. Default: true. */
  promptCaching?: boolean;
  /** Enable extended thinking with the given token budget. */
  thinkingBudget?: number;
  /** beta=1m header for the 1M context window models. Default: false. */
  contextWindow1M?: boolean;
  /** Override base URL (testing / proxies). */
  baseURL?: string;
  /** Inject fetch (testing). The SDK will use this instead of global fetch. */
  fetchFn?: typeof fetch;
}

// ─── helpers (exported for tests; treat as internal API) ──────────────────

/** Anthropic tool name regex: ^[a-zA-Z0-9_-]{1,64}$. The skill `id` field
 *  in agent-skills frontmatter matches `^[a-z][a-z0-9_-]{0,63}$`, which is
 *  a subset — so `shortId` is always safe to use as the tool name. */
export const toolNameOf = (s: SkillSummary): string => s.shortId;

/** Best-effort recovery of shortId from a persisted full identity. Used
 *  when reconstructing assistant turns from history. The harness records
 *  full identities; the LLM saw shortIds. */
export const shortIdFromIdentity = (id: SkillId): string => {
  const m = id.match(/\/([^/@]+)$/);
  return m?.[1] ?? id;
};

/** agent-skills `args` map → Anthropic JSON Schema input_schema.
 *  The shapes overlap heavily; we wrap and add `required` for args without
 *  a `default`. The LLM is permissive enough that extra fields don't hurt. */
export const toInputSchema = (args: Record<string, unknown>): Record<string, unknown> => {
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

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

export const buildTools = (
  available: readonly SkillSummary[],
  cacheLast: boolean,
): AnthropicTool[] => {
  return available.map((s, i) => {
    const tool: AnthropicTool = {
      name: toolNameOf(s),
      description: `${s.title}\n\n${s.description}\n\nUse when: ${s.use_when}`,
      input_schema: toInputSchema(s.args),
    };
    if (cacheLast && i === available.length - 1) {
      tool.cache_control = { type: "ephemeral" };
    }
    return tool;
  });
};

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  [k: string]: unknown;
}

export const toolResultBlocks = (results: readonly ToolCallResult[]): ContentBlock[] =>
  results.map((r) => ({
    type: "tool_result",
    tool_use_id: r.callId,
    content: r.result.stdout || r.result.stderr || "",
    is_error: !r.result.ok,
  }));

export const buildMessages = (
  history: readonly Turn[],
  pendingUser: string | undefined,
  pendingResults: readonly ToolCallResult[] | undefined,
): Array<{ role: "user" | "assistant"; content: ContentBlock[] }> => {
  const messages: Array<{ role: "user" | "assistant"; content: ContentBlock[] }> = [];

  for (const turn of history) {
    const userBlocks: ContentBlock[] = [];
    if (turn.input.user) userBlocks.push({ type: "text", text: turn.input.user });
    if (turn.input.toolResults && turn.input.toolResults.length > 0) {
      userBlocks.push(...toolResultBlocks(turn.input.toolResults));
    }
    if (userBlocks.length > 0) {
      messages.push({ role: "user", content: userBlocks });
    }

    const assistantBlocks: ContentBlock[] = [];
    if (turn.output.text) {
      assistantBlocks.push({ type: "text", text: turn.output.text });
    }
    for (const tc of turn.output.toolCalls) {
      assistantBlocks.push({
        type: "tool_use",
        id: tc.id,
        name: shortIdFromIdentity(tc.skillId),
        input: tc.args,
      });
    }
    if (assistantBlocks.length > 0) {
      messages.push({ role: "assistant", content: assistantBlocks });
    }
  }

  // Current pending input (one of these must be present unless this is the
  // very first call after session creation, in which case neither is set).
  if (pendingUser !== undefined || (pendingResults && pendingResults.length > 0)) {
    const blocks: ContentBlock[] = [];
    if (pendingUser !== undefined) {
      blocks.push({ type: "text", text: pendingUser });
    }
    if (pendingResults && pendingResults.length > 0) {
      blocks.push(...toolResultBlocks(pendingResults));
    }
    if (blocks.length > 0) {
      messages.push({ role: "user", content: blocks });
    }
  }

  return messages;
};

export const mapStopReason = (raw: string | null | undefined): StopReason => {
  switch (raw) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case null:
    case undefined:
      return "end_turn";
    default:
      return "error";
  }
};

/** Build the `system` parameter — either a raw string or a single text
 *  block with `cache_control: ephemeral` for prompt caching. */
export const buildSystemParam = (
  systemPrompt: string,
  useCache: boolean,
): string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> =>
  useCache
    ? [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ]
    : systemPrompt;

export const createAnthropicProvider = (
  opts: AnthropicProviderOpts,
): Provider => {
  const clientOpts: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: opts.apiKey,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    ...(opts.fetchFn !== undefined ? { fetch: opts.fetchFn } : {}),
  };
  const client = new Anthropic(clientOpts);
  const useCache = opts.promptCaching !== false;

  return {
    async *turn(input: TurnInput): AsyncIterable<TurnEvent> {
      // Build a name → full skill id map so we can translate Anthropic's
      // tool_use.name back to our internal SkillId in TurnEvents.
      const nameToId = new Map<string, SkillId>();
      for (const s of input.availableTools) nameToId.set(toolNameOf(s), s.id);

      // System block: cache it. The system prompt is stable across turns;
      // tools are stable across turns; both share one cache lineage.
      const systemParam = buildSystemParam(
        input.systemPrompt,
        useCache,
      ) as Anthropic.MessageStreamParams["system"];

      const tools = buildTools(input.availableTools, useCache);
      const messages = buildMessages(input.history, input.user, input.toolResults);

      // Pending tool_use input arrives as input_json_delta chunks; we
      // accumulate per-block-index and parse at content_block_stop.
      const partialToolInput = new Map<number, string>();
      const toolBlockMeta = new Map<number, { id: string; name: string }>();

      // Build params. The SDK validates the shape at runtime. We cast
      // through `unknown` because the SDK's MessageCreateParamsBase declares
      // optional fields as `T | undefined` rather than `T?`, which clashes
      // with our `exactOptionalPropertyTypes: true` setting at the assignment
      // site. Runtime shape is unambiguously correct.
      const params = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: systemParam,
        messages,
        tools,
        ...(opts.thinkingBudget !== undefined
          ? {
              thinking: {
                type: "enabled" as const,
                budget_tokens: opts.thinkingBudget,
              },
            }
          : {}),
      } as unknown as Anthropic.MessageStreamParams;

      const requestOptions = opts.contextWindow1M
        ? { headers: { "anthropic-beta": "context-1m-2025-08-07" } }
        : undefined;

      let stream;
      try {
        stream = client.messages.stream(params, requestOptions);
      } catch (err) {
        yield { type: "stop", reason: "error" };
        // Surface the message via a final text event so caller has context.
        yield { type: "text", delta: `provider error: ${(err as Error).message}` };
        return;
      }

      try {
        for await (const event of stream) {
          switch (event.type) {
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "tool_use") {
                toolBlockMeta.set(event.index, { id: block.id, name: block.name });
                partialToolInput.set(event.index, "");
              }
              break;
            }
            case "content_block_delta": {
              const delta = event.delta;
              if (delta.type === "text_delta") {
                yield { type: "text", delta: delta.text };
              } else if (delta.type === "thinking_delta") {
                yield { type: "thinking", delta: delta.thinking };
              } else if (delta.type === "input_json_delta") {
                const prev = partialToolInput.get(event.index) ?? "";
                partialToolInput.set(event.index, prev + delta.partial_json);
              }
              break;
            }
            case "content_block_stop": {
              const meta = toolBlockMeta.get(event.index);
              if (meta) {
                const raw = partialToolInput.get(event.index) ?? "";
                let parsed: unknown = {};
                if (raw.length > 0) {
                  try {
                    parsed = JSON.parse(raw);
                  } catch {
                    parsed = { __parse_error: raw };
                  }
                }
                const fullId = nameToId.get(meta.name);
                if (fullId) {
                  yield {
                    type: "tool_call",
                    id: meta.id,
                    skill: fullId,
                    args: parsed,
                  };
                } else {
                  // LLM hallucinated a tool name. Surface as an error tool
                  // call with an unknown skill id; loop.ts will deny it.
                  yield {
                    type: "tool_call",
                    id: meta.id,
                    skill: meta.name as SkillId,
                    args: parsed,
                  };
                }
              }
              break;
            }
            case "message_delta": {
              const reason = mapStopReason(event.delta.stop_reason);
              yield { type: "stop", reason };
              break;
            }
            // message_start / message_stop / others: nothing to forward.
          }
        }
      } catch (err) {
        yield { type: "text", delta: `\nstream error: ${(err as Error).message}` };
        yield { type: "stop", reason: "error" };
      }
    },
  };
};

export type { Provider };
