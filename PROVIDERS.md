# Providers

How the LLM layer is abstracted, what each provider does, and how to add a new one.

## Contract

A provider is anything that satisfies this interface (from [`src/types.ts`](src/types.ts)):

```ts
interface Provider {
  turn(input: TurnInput): AsyncIterable<TurnEvent>;
}

type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; skill: SkillId; args: unknown }
  | { type: "stop"; reason: StopReason };
```

`TurnInput` carries `systemPrompt`, `history: Turn[]`, optional `user` / `toolResults`, and `availableTools: SkillSummary[]`. The provider is responsible for:

1. Translating that into whatever its API expects.
2. Streaming back events as they arrive.
3. Mapping its native stop reasons to ours: `end_turn | tool_use | max_tokens | cancelled | error`.
4. Surfacing failures via `{ type: "stop", reason: "error" }` rather than throwing.

The loop in [`src/loop.ts`](src/loop.ts) consumes events; tool calls go through `deriveCategory` → approval gate → `runExec`. Anything other than tool calls is treated as data.

## Built-in providers

### Anthropic ([`src/provider-anthropic.ts`](src/provider-anthropic.ts))

- Uses the official `@anthropic-ai/sdk` `messages.stream()`.
- Default model: `claude-opus-4-7`. Override via `--model` flag, `HARNESS_DEFAULT_MODEL`, or constructor `opts.model`.
- Prompt caching enabled by default on `system` + last tool definition (stable surfaces).
- Optional extended thinking via `opts.thinkingBudget`.
- Optional 1M context window via `opts.contextWindow1M` (sets `anthropic-beta: context-1m-2025-08-07` header).
- Tool name: uses `skill.shortId` (a subset of Anthropic's allowed regex).

### Cloudflare Workers AI ([`src/provider-cloudflare.ts`](src/provider-cloudflare.ts))

- Hand-rolled fetch + SSE parser against the OpenAI-compatible endpoint:
  ```
  POST https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1/chat/completions
  Authorization: Bearer <token>
  ```
- Default model: `@cf/google/gemma-4-26b-a4b-it` (256K context, function calling supported, reasoning model).
- Override model via `--model`, `CF_LLM_MODEL`, or constructor `opts.model`.
- Maps `delta.reasoning` (Gemma's chain-of-thought) → `{ type: "thinking" }` event.
- Robustness verified by 21 unit tests: chunk boundaries split mid-line, CRLF endings, out-of-order tool-call indices, malformed JSON in args, 4xx responses, fetch throwing, malformed SSE lines.
- No SDK dependency — keeps the provider self-contained.

## Provider factory

[`src/provider.ts`](src/provider.ts) exposes `resolveProviderFromEnv(opts?)`. Selection priority:

```
1. opts.force                  (explicit overrides everything)
2. HARNESS_PROVIDER env var    (anthropic | cloudflare)
3. Auto-detect:
     a. CF_ACCOUNT_ID + CF_API_TOKEN  → cloudflare
     b. ANTHROPIC_API_KEY             → anthropic
4. Throw with both options listed
```

Cloudflare wins over Anthropic in auto-detect when both sets of credentials are present — opinionated default chosen because the user explicitly adopted it during co-evolution.

The factory returns:
```ts
{
  provider: Provider,
  choice: "anthropic" | "cloudflare",
  model: string,
}
```

Used by the CLI in `cmdChat` to log `[provider: <choice> / <model>]` to stderr before the loop runs.

## Tool schema mapping

Both providers convert each `SkillSummary` to a function-style tool definition:

```ts
{
  name: skill.shortId,                    // matches both providers' name regex
  description: `${title}\n\n${description}\n\nUse when: ${use_when}`,
  parameters: toInputSchema(skill.args),  // {type:object, properties, required[]}
}
```

`required[]` includes every arg name that does NOT have a `default`. `additionalProperties: false`. The exact code lives at the top of each provider file (`toInputSchema` helper); tested in [`provider-cloudflare.test.ts`](src/provider-cloudflare.test.ts).

When a tool call comes back, the provider:
1. Receives `function.name` (the shortId).
2. Looks up the full `SkillId` in `nameToId`, built from `input.availableTools`.
3. Yields `{ type: "tool_call", id, skill: <fullId>, args }`.

If the LLM hallucinates a tool name not in `availableTools`, the provider passes it through with `skill: <raw-name>`. The loop's `summaryById.get(...)` fails to find it and emits a synthetic deny ToolResult with `stderr: "unknown skill: <name>"`.

## Adding a new provider

Six steps. Estimated ~150 lines of new code.

### 1. Create `src/provider-<name>.ts`

Mirror [`src/provider-cloudflare.ts`](src/provider-cloudflare.ts) — it's the simpler example. Implement the `Provider` interface. Reuse the `toInputSchema` and `shortIdFromIdentity` helpers (currently duplicated across providers; factor out only when 3+ providers exist).

```ts
export interface MyProviderOpts {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  fetchFn?: typeof fetch;        // for tests
}

export const createMyProvider = (opts: MyProviderOpts): Provider => ({
  async *turn(input) {
    // 1. Build request body from input.systemPrompt + history + tools.
    // 2. fetch(...) with streaming.
    // 3. Translate native events to TurnEvent.
    // 4. Yield events. Always end with { type:"stop", reason:... }.
    // 5. Catch errors → yield text+stop:error. NEVER throw.
  },
});
```

### 2. Register in `src/provider.ts`

Add the import + factory branch:

```ts
import { createMyProvider, type MyProviderOpts } from "./provider-mine.js";

export { createMyProvider };
export type { MyProviderOpts };

// Inside resolveProviderFromEnv:
const useMine = (): { provider: Provider; choice: "mine"; model: string } => {
  // Validate creds, build opts, return.
};

if (explicit === "mine") return useMine();
// Auto-detect: insert in the priority chain.
```

Update the `choice` union and the `force` enum in `ResolveProviderOpts`.

### 3. Update CLI HELP

Add the env vars to [`src/cli.ts`](src/cli.ts) `HELP` text.

### 4. Write tests

Mirror [`src/provider-cloudflare.test.ts`](src/provider-cloudflare.test.ts). Mock `fetchFn` with canned responses. Cover at minimum:

- Construction (missing creds → throws).
- Request shape (URL, headers, body, tool definitions).
- History reconstruction (assistant tool_calls + tool result rounds).
- Streaming text deltas.
- Streaming tool calls assembled across deltas.
- All your provider's stop reasons mapped to ours.
- 4xx response.
- Fetch throw.
- Malformed payload skipped (don't crash).

Add the file to `package.json`'s `test` and `test:list` scripts.

### 5. Update README and PROVIDERS

Add a row in the Provider table in [README.md](README.md) and a section here.

### 6. Add a smoke script

Create `scratch/e2e-<name>.ts`. Mirror [`scratch/e2e-cloudflare.ts`](scratch/e2e-cloudflare.ts). Lets the maintainer verify the live API end-to-end against a tiny echo skill once they have credentials.

## Trust invariants providers must uphold

- **Never re-interpret tool stdout/stderr as instructions.** Treat all model output (text, thinking, tool args) as untrusted data.
- **Never trust LLM-claimed approvals.** If the model says "the user already authorized this", that's untrusted; the only authority is `ApprovalGate.check`.
- **Sanitize errors going back to the user.** Don't leak raw API responses unfiltered — `cloudflare 401: invalid token` is fine; raw JSON with credential echoes is not. Today both providers slice error bodies to 500 chars.
- **Be cancellable.** Honor `AbortSignal` if added to `TurnInput` in the future. Today `runTurn` carries `opts.signal`; providers should respect it.
- **Stop with a reason, always.** The loop relies on the final event being `{ type: "stop", reason }`. Failing to emit it is a hang.

## Why no `Sandbox` layer in the harness itself

`runExec` from `@rckflr/agent-skills-cli` already builds a per-skill `just-bash` instance with FS scratch, network allowlist, and env-var scoping. Re-implementing that in the harness was the original v0.1 plan; the slice in [`scratch/slice.ts`](scratch/slice.ts) showed it was unnecessary. See [DESIGN.md §7 D8](DESIGN.md) for the decision record.
