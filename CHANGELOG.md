# Changelog

Notable changes per `keepachangelog.com`. Versions follow semver once a `1.0.0` ships; until then we track design milestones.

## [0.1.2] — 2026-05-04

### Tests
- **30 new unit tests** for `provider-anthropic.ts` covering: `shortIdFromIdentity`, `toolNameOf`, `toInputSchema`, `buildSystemParam` (cache_control behavior), `buildTools` (cache_control on last tool only), `toolResultBlocks` (ok/error/empty cases), `buildMessages` (history reconstruction with text-only / tool_use / tool_result blocks, pendingResults handling, empty-assistant-turn skipping), `mapStopReason`, plus construction smoke + fetch-failure surfacing.
- Total unit tests: **70 → 100** in 5s. CI smoke set unchanged.

### Refactor
- Exported all pure helpers from `provider-anthropic.ts` for testability: `buildMessages`, `buildTools`, `buildSystemParam`, `toolResultBlocks`, `toInputSchema`, `mapStopReason`, `shortIdFromIdentity`, `toolNameOf`. Treat as internal API — covered by semver but not the primary library surface.
- Extracted `buildSystemParam(systemPrompt, useCache)` from inline closure in `createAnthropicProvider`. The cache_control branching is now testable in isolation.
- Added `fetchFn?: typeof fetch` and `baseURL?: string` to `AnthropicProviderOpts` (matches the Cloudflare provider's testability hooks). Forwarded to the SDK constructor.

### Coverage gap that remains
- The SDK-driven streaming path (content_block_start/_delta/_stop event sequences from `client.messages.stream()`) is NOT mocked. Driving the official SDK with synthetic SSE is brittle to SDK updates. The harness's mapping logic mirrors Cloudflare's, which IS exhaustively tested. If Anthropic becomes the primary production provider, ~10 SDK-mock tests become worth the effort.

## [0.1.1] — 2026-05-04

### CI
- **GitHub Actions workflow** at `.github/workflows/ci.yml`. On every push to `main` and every PR:
  1. Checks out harness + `agent-skills-cli@main` as a sibling.
  2. Builds the sibling's dist.
  3. `npm ci` + `typecheck` + `test` + `build` + `node dist/cli.js --help` in the harness.
  4. Runs `smoke:slice`, `smoke:e2e`, `smoke:cf-driven` (credential-free, deterministic).
- `concurrency` set to cancel in-flight runs on the same ref.
- `smoke:cf-live` deliberately excluded — it spends API tokens.

### Cleanup
- **Removed unused direct deps** `just-bash` and `just-bash-data` from harness `package.json`. They come in transitively via `@rckflr/agent-skills-cli`. Saves 72 packages from npm install. The harness has zero direct imports of either; those names are kept in `tsup.config.ts` `external` purely as defensive guards in case dev code ever adds a direct import.
- TESTING.md and README updated to point at the real CI workflow rather than a hypothetical recipe.

## [0.1.0] — 2026-05-04

### Packaging

- **Build pipeline via tsup** (`tsup.config.ts`). Two entry points:
  - `dist/cli.js` — the `harness` binary, shebang preserved, ready for `npm link` or `npx`.
  - `dist/index.js` — programmatic library API for embedding the harness.
- `package.json` `bin: { harness: ./dist/cli.js }`, `main: ./dist/index.js`, `exports` map for ESM consumers, `files` whitelist (`dist`, `examples`, all docs).
- `prepublishOnly` script chains `typecheck → test → build`, blocking publish on failure.
- New `npm run smoke:*` scripts wire the scratch scripts into npm verbs.
- External deps (Anthropic SDK, agent-skills-cli, just-bash, just-bash-data, yaml) NOT bundled — keep dist tiny (~55K JS + types) and explicit.

### Library surface

- New `src/index.ts` exports the harness as a library: `runTurn`, `createToolbox`, `createSessionStore`, `createApprovalGate`, `deriveCategory`, both providers, both factories, `loadPolicy`, `parseArgs`, plus all shared types. STABLE for the v0 line.

### Verified
- `npm run build` succeeds in ~14s (ESM 0.5s + DTS 13s).
- `node dist/cli.js --help|new|resume|skills list` smoke runs identical to dev (`tsx src/cli.ts ...`).
- Typecheck still clean; 70/70 unit tests still pass.

## [v0] — 2026-05-04

### Status
Contract complete. 70/70 unit tests pass. End-to-end validated against real Gemma 4 26B on Cloudflare Workers AI via the MCP connector. All six DESIGN §8 acceptance criteria met.

### Design
- **DESIGN.md v0.2** — second pass, after a vertical slice against the real stack invalidated the v0.1 plan:
  - Removed the harness's own `Sandbox` abstraction. `runExec` from `@rckflr/agent-skills-cli` already provides per-skill sandboxed `just-bash` instances; duplicating that here would diverge from canonical enforcement.
  - Replaced "add a `category` field upstream" with **derived categorization** from existing spec fields (`network`, `filesystem`, `idempotent`, `provenance.signature_status`). Zero spec changes required.
  - Versions corrected: `agent-skills` is **v1.2.0 STABLE**, not draft v0.3 as some summaries claimed.
- **COEVOLUTION.md** trimmed: of 10 originally-proposed upstream changes, 5 were already shipped, 1 reformulated as policy-side, 4 remain genuinely open (tier promotion of `createBankBash`, optional streaming `runExec`, optional `runChat` primitive, optional `wiki ingest-turn` for compaction).

### Implementation

**Core** (`src/`, ~1700 lines TypeScript, strict + `noUncheckedIndexedAccess`):
- `types.ts` — public interface contracts.
- `toolbox.ts` — `FileBank` + `runQuery` + `runExec`. Real implementation, validated by `slice.ts`.
- `session.ts` — `createBankBash`-backed `db sessions/turns/approvals` collections per session. Snapshot via `db <coll> export`.
- `approval.ts` — `createApprovalGate` + pure `deriveCategory(skill, policy)`. Override map as escape hatch.
- `policy.ts` — YAML loader + `DEFAULT_POLICY` with strict per-key validation (rejects unknown enums, version mismatch, non-object root).
- `loop.ts` — turn protocol. Iterates `provider.turn()` events, drives approval gate, executes via toolbox, persists via session.
- `cli.ts` — `harness new | chat | resume | skills list | skills add`.
- `cli-args.ts` — argv parser extracted from cli for testability.

**Providers**:
- `provider-anthropic.ts` — Anthropic Messages API via `@anthropic-ai/sdk` with prompt caching on system + last tool, optional extended thinking, optional 1M context.
- `provider-cloudflare.ts` — Cloudflare Workers AI via OpenAI-compatible endpoint, hand-rolled fetch + SSE parser, no SDK dep. Default model `@cf/google/gemma-4-26b-a4b-it`. Maps `delta.reasoning` → thinking events.
- `provider.ts` — barrel + `resolveProviderFromEnv` factory. Auto-detect prefers Cloudflare when both sets of creds present.

**Tests**:
- 70 unit tests across 5 suites (`cli-args`, `approval`, `policy`, `provider`, `provider-cloudflare`).
- 4-step `slice.ts` smoke (FileBank + runExec + audit + db export).
- 5-scenario `e2e.ts` (regular auto-allow, explicit user-allow, explicit user-deny, prohibited hard-deny, text-only).
- `e2e-cf-driven.ts` replays Gemma decisions captured via the Cloudflare MCP connector through the full pipeline.
- `e2e-cloudflare.ts` opt-in live test against real Cloudflare API.

### Trust & approval
- Categories derived from `provenance.signature_status`, `network[]`, `filesystem[]`, `idempotent`. Override map keyed by full identity OR shortId.
- Policy matrix maps category → `allow | deny | ask`. Prohibited is hard-deny regardless of matrix.
- TTY prompt as default for `ask`; host can inject custom `ApprovalGate`.
- Default `policy.signature.require_signed: true` — unsigned skills resolve as prohibited unless override map says otherwise.

### Validations against the real stack
- **Direct fetch of source from local clones** of `agent-skills`, `agent-skills-cli`, `just-bash-data`, `just-bash-wiki` confirmed v1.2.0 STABLE spec, v2.3.0 CLI with rich STABLE-tier programmatic API, and bash-first plugins.
- **Slice script** confirmed `runExec` works programmatically, audit appends, separate `createBankBash` for sessions works, `db export` produces re-importable JSON.
- **Three live MCP connector calls to Cloudflare Workers AI** confirmed Gemma 4 26B supports the harness's exact tool schema, generates correctly-formed tool calls, and round-trips cleanly through assistant-tool-tool-final-text.
- **`e2e-cf-driven.ts`** demonstrated PASS end-to-end with real Gemma decisions flowing through the full harness pipeline.

### Known limitations
- `provider-anthropic.ts` is implemented but not unit-tested; integration coverage relies on the SDK's upstream tests.
- Compaction is unsolved. v0 hard-caps turns at `policy.limits.maxTurns` (default 50).
- Approval log lives in two places: session-side (`db approvals` per session) and bank-side (`bank.appendAudit` automatically by `runExec`). They serve different audiences (session replay vs cross-session forensics).
- Skills FileBank and session bank are separate dirs and never share state — required for isolation but doubles disk footprint.
- `createBankBash` is INTERNAL-tier in `agent-skills-cli`. We pin a local version; promotion to STABLE is filed as O1 in [COEVOLUTION.md](COEVOLUTION.md).

### Stack pins
| Package | Version |
|---|---|
| Node | `>=22` |
| `just-bash` | `^2.14.3` |
| `@rckflr/agent-skills-cli` | local `file:../agent-skills-cli` (v2.3.0) |
| `just-bash-data` | local `file:../just-bash-data` (v1.1.2) |
| `@anthropic-ai/sdk` | `^0.40.0` |
| `yaml` | `^2.5.0` |

## [v0.1-design] — earlier

Design-only. Replaced wholesale by v0 after the slice.

- Proposed a harness-level `Sandbox` abstraction (later cancelled — `runExec` covers it).
- Proposed adding `category` field upstream to `agent-skills` spec (later cancelled — derived from existing fields).
- Proposed per-skill `network.allow[]` declarations (cancelled — already in spec §2.10 as `network: string[]`).
- Proposed `db.snapshot/restore` upstream (cancelled — `db export`/`db import` already exist as bash subcommands).
- Proposed mandatory `commitSha` in spec (cancelled — `provenance.ref_resolved_to` already always populated).
