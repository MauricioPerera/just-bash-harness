# Testing

What's tested, what isn't, and why. As of v0.3.0 + post-publish coverage work: **203/203 unit tests pass** in ~30-60s (195 + 8 new in `rekey.test.ts` per issue #8), plus a growing set of integration smokes covering the layers a unit suite can't reach (now including `live-test-chain-approval.ts` per issue #6 and an extended `live-test-encryption.ts` covering both memory AND sessions banks per issue #7).

## Layout

```
src/
  cli-args.test.ts             12 tests   argv parser
  approval.test.ts             26 tests   deriveCategory + gate + chain union + unknown-step worst-case
  approval-stats.test.ts        8 tests   per-skill counters + suggestion threshold logic + YAML render
  loop.test.ts                  7 tests   runCompactionSummary input shape + truncation + stop semantics
  policy.test.ts               10 tests   YAML loader + DEFAULT_POLICY
  policy-overrides.test.ts      5 tests   --allow-unsigned policy mutation
  provider.test.ts             12 tests   resolveProviderFromEnv factory
  provider-anthropic.test.ts   30 tests   helpers + construction + fetch failure surface
  provider-cloudflare.test.ts  49 tests   request + SSE + tool calls + Hermes parser + retry policy
  redact.test.ts               15 tests   pattern coverage + false-positive resistance
  toolbox.test.ts               9 tests   applicable_when filter
  memory.test.ts               12 tests   wiki-backed Memory: recall, persist, filters, charBudget
                              ─────────
                             195 tests
scratch/
  slice.ts                     4-step    FileBank + runQuery + runExec + db export
  e2e.ts                       5-scenario  full loop with scripted provider
  e2e-cf-driven.ts             1 PASS    full loop with replayed live Gemma decisions
  e2e-cloudflare.ts            opt-in    live LLM via real CF creds (not auto-run)
  live-test-memory.ts          5 PASS    cross-session memory recall via SpyProvider
  live-test-compaction.ts      5 PASS    history slicing with compaction enabled
  live-test-encryption.ts      4 PASS    AES-256-GCM at rest verified at the bytes level
  live-test-chains.ts          8 PASS    spec §2.8 chains with output_var substitution
  live-test-hermes.ts          5 PASS    captured Hermes 2 Pro SSE stream replayed
```

## Running

```bash
npm run test           # all unit tests, compact reporter (just tally)
npm run test:list      # all unit tests, spec reporter (per-test names)

# Scratch / integration
npx tsx scratch/slice.ts                  # always passes; no creds needed
npx tsx scratch/e2e.ts                    # always passes; no creds needed
npx tsx scratch/e2e-cf-driven.ts          # always passes; no creds needed (replays
                                          #   real Gemma decisions captured at design time)
CF_ACCOUNT_ID=... CF_API_TOKEN=... npx tsx scratch/e2e-cloudflare.ts
                                          # live API call, costs tokens
```

The unit suite uses Node's built-in test runner (`node --test`) with `tsx` as a loader. No vitest / jest dependency.

## Coverage map

### What's covered

| Concern | Where | Notes |
|---|---|---|
| Argv parsing edge cases | `cli-args.test.ts` | `--key=val`, `--key val`, bare boolean, mixed, duplicates, empty-string, `=` inside value |
| Approval category derivation | `approval.test.ts` | Signature gate, network/filesystem/idempotent escalation, multi-signal, override by full id, override by shortId, override precedence over derivation, prohibited bypass |
| Approval gate behavior | `approval.test.ts` | Hard-deny prohibited regardless of matrix, matrix lookup, audit callback persistence |
| Policy YAML parsing | `policy.test.ts` | Minimal merge with defaults, full override, root non-object rejected, version mismatch rejected, invalid override category rejected, invalid matrix decision rejected, partial matrix override (per-key defaults), wrong-type fallback to default, empty subscribed list, DEFAULT_POLICY shape |
| Provider factory | `provider.test.ts` | Auto-detect priority (CF > Anthropic when both), `HARNESS_PROVIDER` override, `opts.force`, missing creds throws, model precedence chain (`opts.model` > env > default) |
| Cloudflare provider — request shape | `provider-cloudflare.test.ts` | URL construction, Authorization Bearer header, Content-Type, Accept, body shape (model, stream, max_completion_tokens, system+messages+tools, optional `temperature`), tools omitted when empty |
| Cloudflare provider — history reconstruction | `provider-cloudflare.test.ts` | system + prior user + assistant(text+tool_calls) + role:tool result + assistant final + current user — exact 6-message expected |
| Cloudflare provider — text streaming | `provider-cloudflare.test.ts` | Content deltas → text events, finish_reason=stop → end_turn |
| Cloudflare provider — SSE robustness | `provider-cloudflare.test.ts` | **Chunk boundaries split mid-line**, **CRLF endings**, malformed lines silently skipped |
| Cloudflare provider — tool calls | `provider-cloudflare.test.ts` | Args assembled across deltas, name → full SkillId mapping, hallucinated names pass through, **stable order by index across out-of-order chunks**, malformed JSON args → `__parse_error` field |
| Cloudflare provider — reasoning | `provider-cloudflare.test.ts` | `delta.reasoning` → thinking events |
| Cloudflare provider — stop reasons | `provider-cloudflare.test.ts` | stop / length / unknown → end_turn / max_tokens / error |
| Cloudflare provider — error paths | `provider-cloudflare.test.ts` | 4xx response → stop:error + body in text event, fetch throw → stop:error + message |
| Cloudflare provider — schema mapping | `provider-cloudflare.test.ts` | Required args (no `default`) end up in `required[]`, fully optional schema omits the `required` key |
| Cloudflare provider — Hermes inline parser | `provider-cloudflare.test.ts` | `<tool_call>...</tool_call>` blocks split across SSE chunks reassembled, Python-repr → JSON parse, malformed inner content surfaces as `parseFailures` (diagnostic), partial tags held back |
| Cloudflare provider — retry policy | `provider-cloudflare.test.ts` | `parseRetryAfter` (seconds + HTTP date + garbage), `computeBackoffMs` (exponential progression + cap + zero-jitter), 429 once → success on 2nd attempt (Retry-After honored), 503 chain → exhausts maxRetries cleanly, 400 fails fast (non-retryable), AbortSignal during backoff exits, network error retried like 5xx |
| Approval-fatigue suggester | `approval-stats.test.ts` | Threshold logic (minAsks, minAllowRatio), single-deny disqualifies, last_decision=deny disqualifies, sort by ask_count desc, paste-ready YAML rendering |
| Secret redaction patterns | `redact.test.ts` | All 6 default patterns happy paths, multi-secret input, false-positive resistance (UUIDs and env-style PASSWORD assignments NOT clipped), custom pattern list overrides defaults, `scrubToolResult` preserves non-stdout/stderr fields, all DEFAULT_PATTERNS verified `/g` |
| Compaction summary helper | `loop.test.ts` | `runCompactionSummary` formats dropped turns into structured user message (USER/ASSISTANT/TOOLS_CALLED/TOOL_RESULTS), 50K-char input cap with truncation marker, stops on first `stop` event, system prompt includes budget hint, no tools available to summary call |
| Unknown chain step worst-case | `approval.test.ts` | `synthesizeUnknownChainStep` produces fail-closed capability fields (signatureStatus: unsigned, network/filesystem: ["*"], idempotent: false), `deriveCategory` rejects via signature gate, defense in depth: still escalates with require_signed=false, mixed chain (clean known + unknown) → prohibited |
| `--allow-unsigned` flag | `policy-overrides.test.ts` | Flips `signature.require_signed` to false; warns; returns NEW policy (no mutation); ignored when flag has a string value (only literal `true`); no-op when require_signed already false |
| End-to-end loop (no LLM) | `scratch/e2e.ts` | 5 scenarios: regular auto-allow, explicit user-allow, explicit user-deny, prohibited hard-deny, text-only |
| End-to-end loop (live decisions) | `scratch/e2e-cf-driven.ts` | Real Gemma decisions captured via MCP connector replayed through full pipeline (FileBank → runExec → audit → db turns) |
| FileBank + runQuery + runExec | `scratch/slice.ts` | Programmatic API, audit auto-write, separate `createBankBash` for sessions, `db export` round-trip |

### Live LLM smoke asymmetry (deliberate, not an oversight)

The repo has a live LLM smoke for Cloudflare (`scratch/e2e-cloudflare.ts`, opt-in via `npm run smoke:cf-live` with real `CF_ACCOUNT_ID + CF_API_TOKEN`). It does NOT have a live LLM smoke for Anthropic. **This asymmetry is deliberate, not a coverage gap waiting to be filled.**

The reasoning:

- **Cloudflare provider hand-rolls the SSE parser**. Every byte of the stream (chunk boundaries, CRLF, `delta.content` for inline `<tool_call>` tags, `delta.tool_calls` for OpenAI-compat shape, `delta.reasoning` for Gemma's chain-of-thought, finish_reason mapping) is parsed by code in `src/provider-cloudflare.ts`. A live test catches Cloudflare API behavior changes (e.g. a new field, a renamed `finish_reason` value, a streaming contract revision) that unit tests with stubbed SSE wouldn't see. The 49 unit tests cover the parser; the live smoke covers what we don't fully control.
- **Anthropic provider delegates to the official SDK**. `client.messages.stream()` from `@anthropic-ai/sdk` does the parsing. Our code maps SDK events to TurnEvents — the surface area that can drift is the SDK's own event shape, which the SDK's own tests (run by Anthropic) cover. Re-running those tests via a live Anthropic call from our repo would test the SDK, not us. The 30 unit tests cover our mapping helpers; the SDK covers the rest.

So: **CF gets a live smoke because the parser is ours; Anthropic doesn't because the parser is the SDK's.** External rendering tools that compare the two providers may synthesize a phantom "Anthropic live smoke (Opt-in)" by structural symmetry — that smoke does not exist and is not on the roadmap. Doctrine #6 in `LESSONS.md` calls out this synthesis-by-symmetry pattern explicitly.

If a future provider also hand-rolls its parser (e.g. a hypothetical Mistral via raw fetch), it should ship with a live smoke matching the CF pattern. If it goes through a vendor SDK, it shouldn't.

### What's NOT unit-tested (deliberate)

| Module | Reason |
|---|---|
| `provider-anthropic.ts` (full SDK stream parse) | Helpers (`buildMessages`, `buildTools`, `toInputSchema`, `mapStopReason`, `shortIdFromIdentity`, `toolNameOf`, `buildSystemParam`, `toolResultBlocks`) ARE unit-tested. The full `MessageStream` event-translation path (content_block_start / _delta / _stop sequences) is NOT mocked — driving the official SDK with synthetic SSE bodies is brittle to SDK updates. Construction + fetch failure surfacing IS covered. The remaining surface mirrors Cloudflare's; same shape, well-exercised by parallel tests. See "Live LLM smoke asymmetry" above for why there is also no live Anthropic smoke. |
| `rekey.ts` integration with real `just-bash-data` encryption | The pure orchestration logic (export-with-old → import-with-new → atomic rename, dry-run path, concurrent-process detection, stops-on-first-error, skills target wiring) IS unit-tested in `rekey.test.ts` via a stubbed `bashFactory` that records every `db <coll>` call. What is NOT covered: end-to-end with a real encrypted just-bash-data bank — that's manually verified per release. A future `live-test-rekey.ts` smoke could close this if needed. |
| `loop.ts` (`runTurn` orchestration) | Covered by integration: 5 `e2e.ts` scenarios exercise every branch (regular auto-allow, explicit ask→allow, explicit ask→deny, prohibited hard-deny, text-only termination) plus one Gemma-driven variant + the dedicated memory / compaction smokes. The pure helpers extracted from `runTurn` (`runCompactionSummary`, `synthesizeUnknownChainStep`) ARE unit-tested. |
| `toolbox.ts` (`createToolbox`, `summarize`) | `applicable_when` filtering IS unit-tested in `toolbox.test.ts`. The remaining surface (runQuery + runExec round-trip with audit) is covered by integration via `slice.ts`. Mocking `FileBank` adequately is more code than the test would save. |
| `session.ts` (`createSessionStore`, `restoreSnapshot`) | Covered by integration: `slice.ts` exercises the bash-backed `db sessions/turns/approvals insert/find/export`; `e2e.ts` exercises `appendTurn` + `load`; `e2e-cf-driven.ts` exercises the full round-trip post-loop. |
| `rekey.ts` (`runRekey` end-to-end) | The orchestration is fs + bash-driven and depends on `just-bash-data`'s actual encryption behavior. Unit testing would require mocking `bash.exec` at a level that re-implements db semantics. Smoke-tested manually for v0.3.0; a future stubbed-bash integration test is on the list. |
| `approval-stats.ts` (`createApprovalStatsStore` runtime) | Pure functions (`suggestOverrides`, `renderSuggestionsYaml`) ARE unit-tested. The bash-backed `record` / `list` methods round-trip through `db approval_stats` — covered indirectly by anyone using `harness chat` with the stats store wired. |
| `cli.ts` subcommands (`cmdNew`, `cmdChat`, etc.) | Smoke-tested manually during dev: `harness new`, `harness resume`, `harness skills list` were each invoked. CLI behavior tests would require process-spawning fixtures. |

### Risks the suite explicitly blinds against

| Risk | Test that catches it |
|---|---|
| `deriveCategory` regression auto-allows a network-using skill | `network non-empty → explicit` |
| Override map silently accepts an invalid category | `loadPolicy: rejects invalid override category` |
| YAML matrix accepts arbitrary verbs (`yolo`) | `loadPolicy: rejects invalid matrix decision` |
| argv parser eats next flag as value of bare boolean | `parseArgs: bare --flag at end → true` + `--flag followed by --other → true` |
| SSE stream chunked mid-payload loses an event | `cloudflare provider: chunk boundaries split mid-line are reassembled` |
| CRLF line endings break parser | `cloudflare provider: handles CRLF line endings` |
| Tool call args assembled in wrong order when CF returns out-of-order | `cloudflare provider: tool_calls stable order by index across out-of-order chunks` |
| Provider crashes silently on 4xx, leaving the loop hung | `cloudflare provider: 4xx response → stop:error + error text` |
| LLM hallucinates a tool name → harness runs unintended code | `cloudflare provider: unknown tool name yields tool_call with raw name (loop denies)` + integration: `e2e.ts` scenario D shows the loop denies unknown skills |
| Malformed JSON args from LLM → parse error swallowed | `cloudflare provider: malformed tool_call JSON surfaces as __parse_error` |
| Factory chooses Anthropic over Cloudflare when both creds present | `resolveProviderFromEnv: prefers cloudflare in auto-detect` |

## Adding a test

Follow the patterns in existing files:

- **Unit tests** live next to the module they test as `<module>.test.ts`. They use `node:test` and `node:assert/strict`.
- **Add the file path** to the `test` and `test:list` scripts in `package.json` (Node's `--test` flag does not glob reliably across platforms; we list files explicitly).
- **Tests must not depend on each other** or on shared global state. Use `mkdtemp` for any disk fixtures and clean up in `finally`.

Example skeleton:

```ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { thingUnderTest } from "./thing.js";

test("thing: behavior under normal inputs", () => {
  assert.equal(thingUnderTest(2), 4);
});

test("thing: rejects invalid input", () => {
  assert.throws(() => thingUnderTest(-1), /must be non-negative/);
});
```

For tests that need the harness's complex types, see `provider-cloudflare.test.ts`'s `minimalTools()` / `minimalInput()` helpers — copy that pattern.

## Running on CI

The shipped workflow is at [`.github/workflows/ci.yml`](.github/workflows/ci.yml). It:

1. Checks out the harness and `MauricioPerera/agent-skills-cli@main` as a sibling at `../agent-skills-cli`.
2. Sets up Node 22 with cached `node_modules` keyed by both lockfiles.
3. `npm ci && npm run build` in the sibling (creates its `dist/`).
4. `npm ci` in the harness (resolves the `file:../agent-skills-cli` dep against the just-built dist).
5. Runs `typecheck`, `test`, `build`, then `node dist/cli.js --help` to confirm the bin works.
6. Runs `smoke:slice`, `smoke:e2e`, and `smoke:cf-driven` (all credential-free, all deterministic).

`smoke:cf-live` is NOT in CI — it spends Cloudflare tokens and depends on live availability. Run it manually before releases:

```bash
CF_ACCOUNT_ID=... CF_API_TOKEN=... npm run smoke:cf-live
```

### Notes
- The sibling-checkout pattern means a breaking change in `agent-skills-cli@main` will fail this CI immediately. That's intentional — we want the early signal. To pin to a specific tag instead, change `ref: main` in the workflow.
- `concurrency: cancel-in-progress` ensures rapid iteration: a new push cancels older in-flight runs on the same ref.
- Total CI time is ~3 minutes cold (npm cache miss) and ~90s warm.
