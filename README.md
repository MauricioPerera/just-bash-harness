# just-bash-harness

Single-agent loop on top of [`just-bash`](https://github.com/vercel-labs/just-bash) and the [`agent-skills`](https://github.com/MauricioPerera/agent-skills) ecosystem. Sandboxed tool execution, derived approval gates, persisted sessions, swappable LLM providers.

**Version:** 0.3.0 · **Status:** v0 contract complete + packaged + CI'd + polished + applicable_when filter + cross-session memory + search/stats/export + compaction (with optional rolling LLM summary) + AES-256-GCM at rest (with `harness rekey` rotation) + retrieval bench + interactive REPL + chains (with chain-aware approval, no bypass) + Hermes parser w/ diagnostics + AbortSignal propagation + per-tool-call rationale + secret redaction at persistence boundaries + approval-fatigue metrics + Cloudflare provider rate-limit + backoff. 195/195 unit tests pass. End-to-end validated against real Gemma 4 26B and Hermes 2 Pro on Cloudflare Workers AI subscribing the public `agent-skills-pack@v2.2.0`. Published as `just-bash-harness` on the npm registry.

## Intended audience

This is **maintainer-grade software for a specific ecosystem**, not a generic agent harness aiming for mass adoption. It's designed for:

- The maintainer of the `agent-skills` / `just-bash` stack (`@rckflr/agent-skills-cli`, `just-bash-data`, `just-bash-wiki`) and tightly-integrated downstreams.
- Early-adopter engineers comfortable reading the source, willing to track a small stack of related packages, and able to make their own calls on the open trade-offs.

If you want a broader-purpose agent runtime with multi-tenancy, GUI, and strong integration with arbitrary tool ecosystems, this isn't it. If you want a small, auditable loop that composes the `agent-skills` spec primitives end-to-end, it is.

### Trade-offs that landed but still have caveats

These were originally listed as outright gaps in v0.2.7. v0.3.0 closed each of them, but with caveats worth knowing before adopting:

- **Secret redaction in tool stdout**: implemented as a Phase 1 conservative regex pass (AWS keys, GitHub tokens, Slack tokens, JWT shape, PEM private-key blocks). Phase 2 is *not* implemented: there is no `policy.redaction` config for adding custom patterns, no per-skill opt-out (so a skill that legitimately handles JWTs will see its output redacted), and no generic high-entropy or env-style assignment patterns (would clip too many false positives without policy config).
- **Encryption key rotation**: implemented as `harness rekey` with `--dry-run` validation and atomic rename. Caveats: the mv → mv window between backup and promote is sub-second but NOT strictly atomic; the command refuses to run if the target dir was modified <60s ago (best-effort, not a real lock); and the collection list is hardcoded per bank kind, so adding new collections in a future release requires updating `rekey.ts` to migrate them.
- **Single-tenant**: still the explicit design assumption. `harness rekey` and approval-stats both implicitly rely on it (race-condition-prone in concurrent multi-process scenarios). Multi-tenancy is not on the roadmap; if you need it, the harness is the wrong starting point.

These are not bugs — they are design points where the cheap thing landed and the comprehensive thing didn't. Each is tracked in `CHANGELOG.md` for v0.3.0 with rationale, and each has a clear path to a follow-up if/when needed.

## What it is

A thin orchestrator (~4100 LOC TypeScript in `src/`, plus ~2400 LOC of unit tests) that:

- Runs a turn loop: prompt → tool calls → results → next turn → end.
- Resolves tool calls to **agent-skills** subscribed in a local `FileBank`.
- Executes each skill in `runExec`'s per-skill sandboxed `just-bash` instance (FS scratch, network allowlist, env scoping — already provided by [`@rckflr/agent-skills-cli`](https://github.com/MauricioPerera/agent-skills-cli)).
- Categorizes each tool call as **prohibited / explicit / regular** *derived from* existing skill metadata (no new spec field) and applies the policy matrix.
- Persists session state via `db sessions/turns/approvals` collections in a dedicated [`just-bash-data`](https://github.com/MauricioPerera/just-bash-data) bank.
- Speaks to **Anthropic Messages API** or **Cloudflare Workers AI** (default model: `@cf/google/gemma-4-26b-a4b-it`).

## What it is *not*

- A multi-agent orchestrator. Single agent only.
- A multi-tenant deployment. Single user assumption is intact.
- A sandbox for untrusted user code. The user is trusted; the LLM and skills are not (see [DESIGN.md §2](DESIGN.md)).
- A web UI. CLI / TTY only.

## Quickstart

```bash
git clone <this-repo> harness
cd harness
npm install
npm run build                                         # → dist/cli.js, dist/index.js

# Pick a provider via env (auto-detected). Either of these works:
export CF_ACCOUNT_ID=...   CF_API_TOKEN=...           # → Gemma 4 26B
export ANTHROPIC_API_KEY=...                          # → claude-opus-4-7

# Optional: real semantic retrieval (else stub embedder)
export OLLAMA_MODEL=nomic-embed-text                  # or OPENAI_*, CF_*

# Subscribe a skill pack (signed git tag enforced by default)
node dist/cli.js skills add github.com/foo/bar@v1.0.0

# Run a chat turn
SID=$(node dist/cli.js new)
echo "say hi using the available tools" | node dist/cli.js chat "$SID"

# Resume later
node dist/cli.js resume "$SID"
```

#### Working with unsigned skills (local development)

The default policy is `signature.require_signed: true`, so any pack whose git tag isn't gitsign / GitHub-OIDC verified resolves to category `prohibited` and gets hard-denied at the approval gate. The deny error in tool stdout now points at three remediations: sign the tag, add a per-skill override, or pass `--allow-unsigned` to the chat command for development:

```bash
# Drop the signature gate for one chat invocation (development only)
harness chat "$SID" --allow-unsigned --message "test the local skill"
```

`--allow-unsigned` flips `signature.require_signed` to `false` in memory for that invocation only. Unsigned skills then fall through to the capability heuristics (network/filesystem/idempotency) and most will resolve as `explicit` — meaning the user gets prompted at the TTY before each call, instead of being silently denied.

For a permanent override on a specific trusted skill, use `policy.skills.overrides[skill.id] = "regular" | "explicit"` in your policy YAML.

### Install globally

```bash
npm link                       # makes `harness` available on PATH
harness --help
```

Or run directly through `tsx` during development without building:

```bash
npx tsx src/cli.ts --help
```

## Architecture in one diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ cli (TTY / REPL / slash commands / harness rekey, audit, etc.)  │  user-facing
├─────────────────────────────────────────────────────────────────┤
│ loop                                                            │  turn protocol +
│ (turn protocol · compaction · summary · AbortSignal · redact)   │   pipeline
├──────────────┬──────────────┬──────────────┬───────────────────┤
│ provider     │ approval gate│ memory       │ session           │  cross-cutting
│ (Anthropic / │ (deriveCat·  │ (recall +    │ (db turns/        │   (one node
│  CF Workers; │  override·   │  compaction- │  approvals/       │    each — not
│  retry +     │  TTY prompt; │  summary;    │  approval_stats   │    "concerns")
│  backoff)    │  chains-aware│  wiki-backed)│  per session)     │
│              │  union)      │              │                   │
├──────────────┴──────────────┴──────────────┴───────────────────┤
│ toolbox (FileBank + runQuery + applicable_when filter +         │  skill bank +
│          runExec → scrub-secrets → ToolResult)                  │   exec
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                      agent-skills-cli                                ← skills runtime
              (runExec sandbox per skill ·
               createBankBash for storage handles)
                              │
                              ▼
                          just-bash                                   ← platform
              (process isolation · FS scratch ·
               network allowlist · env scoping ·
               AES-256-GCM at rest)
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
        just-bash-data              just-bash-wiki                    ← storage plugins
        (db / vec engine            (page/source layer
         under all banks)            backing memory)
```

There is **no** `Sandbox` layer of our own. `runExec` already builds a per-skill sandboxed `just-bash` instance with the skill's declared `network` / `filesystem` / `required_env` constraints from the spec. Re-implementing that here would diverge from the canonical enforcement.

The trust pipeline for every tool call is: **LLM → provider → loop → approval gate → toolbox → runExec (just-bash sandbox) → ToolResult → scrub-secrets → persistence (db turns + memory) → next provider call**. Tool stdout is untrusted at every step after `runExec` — DESIGN §2 makes this explicit, and `src/redact.ts` enforces it before persistence.

See [DESIGN.md](DESIGN.md) for full layer contracts and [DESIGN.md §4](DESIGN.md) for the turn protocol.

## Providers

Two LLM providers ship today; the factory auto-detects from env:

| Provider | Default model | Required env |
|---|---|---|
| Anthropic Messages API | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| Cloudflare Workers AI | `@cf/google/gemma-4-26b-a4b-it` | `CF_ACCOUNT_ID`, `CF_API_TOKEN` |

Auto-detect prefers Cloudflare when both sets of credentials are present. Override via `HARNESS_PROVIDER=anthropic|cloudflare`. Override the model via `--model <id>` flag, `HARNESS_DEFAULT_MODEL` (Anthropic), or `CF_LLM_MODEL` (Cloudflare).

See [PROVIDERS.md](PROVIDERS.md) for adding a new provider.

## Approval categories — derived, not declared

The harness derives a category for every tool call from existing spec fields:

| Signal | Effect |
|---|---|
| `provenance.signature_status !== "valid"` while `policy.signature.require_signed: true` | → **prohibited** (hard deny) |
| `network[]` non-empty | → escalate to **explicit** |
| `filesystem[]` non-empty | → escalate to **explicit** |
| `idempotent: false` | → escalate to **explicit** |
| Override map matches by full id or shortId | → forced category (escape hatch) |
| Otherwise | → **regular** |

Default policy matrix:

```
prohibited → deny       (hard, never asks)
explicit   → ask        (TTY prompt unless host injects custom gate)
regular    → allow      (auto-approved, audit-only)
```

This means **no spec changes** were needed to ship the harness — the security category is a function of fields the spec already defines (`network`, `filesystem`, `idempotent`, `provenance`).

## Sessions

Each session lives under `<sessionsRoot>/<sessionId>/` and is backed by a dedicated `just-bash-data` bank with three collections:

```
db sessions    — one document with policy snapshot + metadata
db turns       — append-only history; each Turn includes user message,
                 LLM output, tool calls, approvals
db approvals   — flat audit of every approval decision (allow/deny,
                 source: policy or user, derivation reasons)
```

`harness resume <id>` re-opens the dir; `db turns find '{}' --sort ts:1` rehydrates history. `db <coll> export` produces JSON snapshots; `db <coll> import` round-trips them.

The skills `FileBank` and the session bank live on **separate dirs**. They never share state.

## Testing

As of v0.3.0: **195 unit tests across 12 test files** (all PASS, ~30-60s) plus **9 smoke / integration scripts** in `scratch/`. See [TESTING.md](TESTING.md) for the full coverage matrix per module.

| Layer | Tests | Where |
|---|---|---|
| Unit | 195 in 12 suites | `src/*.test.ts` |
| Integration — FileBank + runExec round-trip | 4-step PASS | `scratch/slice.ts` |
| Integration — full loop, scripted provider | 5-scenario PASS | `scratch/e2e.ts` |
| Integration — Gemma decisions replayed | 1 PASS | `scratch/e2e-cf-driven.ts` |
| Integration — cross-session memory | 5 PASS | `scratch/live-test-memory.ts` |
| Integration — compaction (history slicing) | 5 PASS | `scratch/live-test-compaction.ts` |
| Integration — AES-256-GCM at rest | 4 PASS | `scratch/live-test-encryption.ts` |
| Integration — chains (multi-skill orchestration) | 8 PASS | `scratch/live-test-chains.ts` |
| Integration — Hermes inline `<tool_call>` parser | 5 PASS | `scratch/live-test-hermes.ts` *(replays a captured SSE stream — NOT a live LLM call)* |
| Integration — summarize=false regression guard | 4 PASS | `scratch/live-test-summarize-disabled.ts` |
| Live LLM (CF, real fetch) | opt-in | `scratch/e2e-cloudflare.ts` *(requires `CF_ACCOUNT_ID` + `CF_API_TOKEN`)* |

**On the "live" distinction:** `live-test-hermes.ts` and `e2e-cf-driven.ts` are NOT live LLM calls — they replay deterministic streams captured at design time. They are categorized as "Integration" above, not "Live LLM". The only live-LLM smoke is `e2e-cloudflare.ts`, which is opt-in and requires real Cloudflare credentials. No live Anthropic smoke exists by design — see [TESTING.md "Live LLM smoke asymmetry"](TESTING.md) for the rationale.

```bash
npm run test               # all unit tests, compact reporter
npm run test:list          # all unit tests, spec reporter
npm run smoke:slice        # FileBank + runExec round-trip
npm run smoke:e2e          # full loop, 5 approval scenarios
npm run smoke:cf-driven    # full loop, replayed Gemma decisions
```

CI runs the typecheck + tests + build + the three credential-free smokes on every push to `main` and every PR. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml) and [TESTING.md](TESTING.md) for what's covered and what's intentionally not unit-tested.

## Lessons

[LESSONS.md](LESSONS.md) captures operational doctrines distilled from real bugs: each entry is anchored to the release where the bug surfaced (e.g. v0.2.3 chains-bypass-approval) and stated as a one-sentence rule that should fire in code review for related future features. Read at design time, not incident time.

## Layout

```
src/
  index.ts                library barrel — programmatic API
  types.ts                shared interface contracts (DESIGN §3)
  toolbox.ts              FileBank + runQuery + runExec
  provider.ts             provider barrel + env factory
  provider-anthropic.ts   Anthropic Messages API adapter
  provider-cloudflare.ts  Cloudflare Workers AI (OpenAI-compat endpoint)
  approval.ts             gate + deriveCategory + TTY prompt
  session.ts              createBankBash-backed db wrappers
  policy.ts               YAML loader + DEFAULT_POLICY
  loop.ts                 turn orchestrator
  cli.ts                  entry point — built into bin/harness
  cli-args.ts             argv parser (extracted for testability)
  *.test.ts               70 unit tests (cli-args, approval, policy,
                          provider factory, cloudflare provider)
scratch/                  smoke/integration scripts
examples/                 example policy YAML
dist/                     build output (gitignored, npm-published)
  cli.js                  the harness binary (shebang preserved)
  index.js                programmatic library entry
  *.d.ts                  TypeScript declarations
tsup.config.ts            build config (ESM, node22 target)
DESIGN.md                 contract — read first
PROVIDERS.md              provider abstraction + how to add one
TESTING.md                test layout + coverage notes
COEVOLUTION.md            upstream changes plan (mostly cancelled — see file)
CHANGELOG.md              project journey, v0 + v0.1
```

## Stack version pins

| Package | Version pinned to | Notes |
|---|---|---|
| `just-bash` | `^2.14.3` | beta but stable surface |
| `@rckflr/agent-skills-cli` | local `file:../agent-skills-cli` | uses STABLE-tier exports + one INTERNAL (`createBankBash`) |
| `just-bash-data` | local `file:../just-bash-data` | bash-first; `db`/`vec` subcommands |
| `@anthropic-ai/sdk` | `^0.40.0` | for Anthropic provider |
| `yaml` | `^2.5.0` | policy parsing |
| Node | `>=22` | required by agent-skills-cli + native `fetch`/`ReadableStream` |

## License

Same as the surrounding ecosystem (MIT). Copy attribution from contributing repos when forking.
