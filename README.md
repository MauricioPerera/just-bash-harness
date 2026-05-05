# just-bash-harness

Single-agent loop on top of [`just-bash`](https://github.com/vercel-labs/just-bash) and the [`agent-skills`](https://github.com/MauricioPerera/agent-skills) ecosystem. Sandboxed tool execution, derived approval gates, persisted sessions, swappable LLM providers.

**Version:** 0.1.7 · **Status:** v0 contract complete + packaged + CI'd + polished + applicable_when filter + cross-session memory + memory search/stats/export + **compaction** (lifts the maxTurns ceiling: provider window stays bounded while sessions/memory keep everything). 133/133 unit tests pass. End-to-end validated against real Gemma 4 26B on Cloudflare Workers AI subscribing the public `agent-skills-pack@v2.2.0`. Distributable as a `harness` binary via `npm run build`.

## What it is

A thin orchestrator (~1700 LOC TypeScript) that:

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
┌──────────────────────────────────────────┐
│  cli (TTY)                               │  user-facing
├──────────────────────────────────────────┤
│  loop                                    │  turn protocol
├──────────────────────────────────────────┤
│  provider   approval   session   policy  │  cross-cutting
├──────────────────────────────────────────┤
│  toolbox  ←  FileBank + runQuery/runExec │  skill resolution + execution
└──────────────────────────────────────────┘
                 │
                 ▼
   agent-skills-cli (handles per-skill sandbox)
                 │
                 ▼
            just-bash + just-bash-data
```

There is **no** `Sandbox` layer of our own. `runExec` already builds a per-skill sandboxed `just-bash` instance with the skill's declared `network` / `filesystem` / `required_env` constraints from the spec. Re-implementing that here would diverge from the canonical enforcement.

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

| Layer | Tests | Where |
|---|---|---|
| Unit | 100 in 6 suites | `src/*.test.ts` |
| Integration (no LLM) | 4 (slice) + 5 (e2e scripted) | `scratch/{slice,e2e}.ts` |
| Live LLM (Gemma) | 1 PASS | `scratch/e2e-cf-driven.ts` |
| Live LLM (CF, real fetch) | listed, opt-in | `scratch/e2e-cloudflare.ts` |

```bash
npm run test               # all unit tests, compact reporter
npm run test:list          # all unit tests, spec reporter
npm run smoke:slice        # FileBank + runExec round-trip
npm run smoke:e2e          # full loop, 5 approval scenarios
npm run smoke:cf-driven    # full loop, replayed Gemma decisions
```

CI runs the typecheck + tests + build + the three credential-free smokes on every push to `main` and every PR. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml) and [TESTING.md](TESTING.md) for what's covered and what's intentionally not unit-tested.

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
