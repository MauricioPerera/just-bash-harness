# Changelog

Notable changes per `keepachangelog.com`. Versions follow semver once a `1.0.0` ships; until then we track design milestones.

## [0.2.4] — 2026-05-05

### Cleanups from external review

Four small fixes addressed together. None changes behavior; all clean up code/docs that were misleading or outdated.

- **Removed unimplemented `redacted` field from `ToolResult`.** Was always set to `false` everywhere it was constructed; never had backing implementation. Removed from `types.ts`, `loop.ts`, `toolbox.ts`, and the test fixtures in `provider-anthropic.test.ts` + `provider-cloudflare.test.ts`. If real redaction lands later (regex of secrets, scrubbing stdout), restore the field as a definitive `true` indicator.
- **Synced `examples/policy.example.yaml`** with the actual schema. Previous version listed `network`, `telemetry.auditLogPath` (silently ignored by loader) and was missing `memory`, `encryption`, `signature`, `paths.sessionsRoot`. New version is a complete annotated reference for a policy file, with comments explaining each section.
- **Removed unreachable throw in `policy.ts`** at the `paths.sessionsRoot` validation. `DEFAULT_POLICY.paths.sessionsRoot` is always defined at module init, so the throw could never fire. Removed; replaced with a brief comment so the invariant doesn't get re-introduced.
- **Simplified redundant condition in `processHermesBuffer`.** The previous `TAG_OPEN.startsWith(suffix) && suffix === TAG_OPEN.slice(0, i) && suffix.startsWith("<")` was tautological given the first check. Folded into a single condition + length guard.

### Tests
- All 140 existing tests still pass.
- The `redacted: false` removal cascaded through 9 fixture sites (4 `redacted:` lines in source + 5 in test fixtures — actually 10, including a sixth in `cloudflare.test.ts`). Stripped via `awk` in one pass; verified by typecheck + full run.

### Acknowledgement
Items #2, #6, #7, #8 from the v0.2.2 external review.

## [0.2.3] — 2026-05-05

### SECURITY: chains no longer bypass the approval gate

Pre-0.2.3, when a parent skill declared `chains[]`, only the parent's capabilities were evaluated by `deriveCategory`. Chain steps with `network`, `filesystem`, or `idempotent: false` ran via `runExec` without the user ever seeing them at the approval prompt. The CHANGELOG v0.2.1 claim that "security isolation is preserved because each step runs in its own sandbox" was about runtime isolation only; the human-in-the-loop approval was being silently bypassed.

**Concrete attack vector** (now closed): a benign-looking parent (`signed`, `idempotent: true`, `network: []` → category `regular` → auto-allow) declares a chain step to a skill with `network: ["evil.com"]`. User sees no prompt. Network call goes through. The user thought they approved a harmless tool; they actually approved a pipeline.

**Fix**: `deriveCategory(skill, policy, chainSkills?)` now takes an optional array of resolved chain skills and computes the **union** of capabilities over the parent + every chain step. The worst category wins. The `derivedFrom` array tags chain-attributed reasons with `chain:<short-id>` so the approval prompt shows where each capability came from.

The override map still wins as the documented escape hatch — explicitly trusting the whole chain by id is the user's prerogative.

### Loop wiring
- `runTurn` now resolves each chain step's identity to its `SkillSummary` from the bank before approval. Steps pointing at unknown skills are treated as worst-case (unsigned + unrestricted network/filesystem + non-idempotent), forcing a deny under any reasonable policy.

### Tests
- 6 new unit tests covering: child-network-escalates-parent, child-non-idempotent-escalates, signature-gate-over-union, multi-step-all-clean, backward-compat (empty chainSkills), override-wins-over-chain-derivation.
- Existing chain smoke (`scratch/live-test-chains.ts`) still passes — the test skills are all idempotent + signed + no network, so they correctly resolve as `regular` even with the new rules.
- Total: 134 → 140 unit tests.

### Acknowledgement
This issue was identified by an external review of v0.2.2. Worth calling out specifically: the chain mechanism shipped in v0.2.1 with a CHANGELOG line that overstated the security guarantee. Lesson: when adding a new orchestration layer, audit every prior approval invariant to confirm it still holds.

## [0.2.2] — 2026-05-05

### Hermes-style `<tool_call>` parser in the Cloudflare provider

Hermes 2 Pro and similar models on Workers AI emit tool calls inline in `delta.content` as XML-like tags with Python-repr-style payloads, NOT in `delta.tool_calls`:

```
<tool_call>
{'arguments': {'value': 'hello'}, 'name': 'base64-encode'}
</tool_call>
```

Plus they return `finish_reason: "stop"` even when a tool call was emitted. The provider's OpenAI-compat parser previously missed these — Granite/Gemma worked because they use the standard `tool_calls` array, but Hermes failed silently.

Fix: a buffer-aware text processor that:
- Detects `<tool_call>...</tool_call>` blocks across chunked deltas (handles partial tags split mid-stream)
- Parses the Python-repr-style inner content (single-quote → double-quote → JSON.parse)
- Suppresses raw markup from text events the user sees
- Synthesizes proper `tool_call` TurnEvents with name → full SkillId mapping
- When tool calls are synthesized this way, overrides `finish_reason: "stop"` to `"tool_use"` so the loop knows to feed back tool_results

### Tests
- 13 new unit tests in `provider-cloudflare.test.ts`:
  - `parseHermesPayload` — single-quoted dict, with newlines, missing name, garbage
  - `processHermesBuffer` — plain text, complete block, text+tag+text, incomplete tag, partial open, two tags, malformed inner content, lone `<`, ambiguous `<` mid-text
- 1 new smoke `scratch/live-test-hermes.ts` — replays the EXACT 31-chunk SSE stream captured live from `@hf/nousresearch/hermes-2-pro-mistral-7b` via the MCP connector. **5/5 checks PASS.**
- Total unit tests: 121 → 134.

### What still works unchanged
- Granite, Gemma, Llama, etc. that use the standard `delta.tool_calls` array — every existing test passed without modification.
- Anthropic provider — unchanged.

### Caveat
The Python-repr parser is naive: it does single → double quote replacement. Strings containing literal single quotes (`"user's input"`) would break. Hermes 2 Pro tends to escape these or use double quotes around user content, so this is acceptable for v1; can be hardened with a proper Python-repr tokenizer if a real failure surfaces.

## [0.2.1] — 2026-05-05

### Chains (spec §2.8) — multi-skill orchestration with output piping

A skill's `chains` field declares additional skills to run automatically after the parent succeeds. The harness now executes them as an atomic unit — one approval, one ToolResult — with `${VAR}` substitution between steps.

### How it works
- After the parent's `runExec` succeeds, the harness iterates `skill.chains[]`.
- Each step's `args` are scanned for `${VAR}` placeholders and replaced with values captured from previously-declared `output_var`s.
- Special variable `${PARENT_OUTPUT}` always holds the parent's stdout.
- After each step runs, if it declared `output_var: "X"`, its stdout is captured as `${X}` for downstream steps.
- Any non-zero exit or timeout in the chain stops further steps; the worst exit code wins; aggregated stdout/stderr is returned with `[skill-id]` and `[chain skill-id]` banners separating sections.

### Approval semantics
Chains derive a SINGLE approval category at the parent's tool_call boundary — the LLM sees one tool, the user approves once. Each chain step still runs in its own per-skill `runExec` sandbox (FS scratch, network allowlist, env scoping per spec §4.4), so security isolation is preserved.

### Types
- `SkillSummary.chains?: readonly ChainStep[]` — populated by `summarize()` from the IndexedSkill. The agent-skills-cli's `ChainStep` type (`{ skill, args?, output_var? }`) is re-exported from `src/types.ts` for embedders.

### Smoke (`scratch/live-test-chains.ts`)
Three synthetic skills:
- parent → echoes "from-parent"
- step1 → consumes `${PARENT_OUTPUT}`, prints "step1-saw:from-parent", captured as STEP1_VAR
- step2 → consumes `${STEP1_VAR}`, prints "step2-saw:step1-saw:from-parent"

Runs the parent through the toolbox and asserts:
- result.ok = true and exitCode = 0
- stdout contains the parent banner + literal output
- step1 banner + correctly-substituted output
- step2 banner + chain-of-vars output ("step2-saw:step1-saw:from-parent")

**8/8 checks PASS.**

### Limits noted
- The agent-skills-pack@v2.2.0 doesn't currently use chains — feature is implemented in the harness regardless. Skills declaring chains can be authored independently.
- During smoke development, an awk-based reverse step hit just-bash's per-command loop limit (10K iterations). Lesson: chain steps must respect the just-bash loop budget; for non-trivial transformations the user can split into multiple chained skills rather than one heavy step. Documented as guidance, not as a code change.

## [0.2.0] — 2026-05-05

### Interactive REPL

Major UX shift: `harness chat` is no longer one-shot. When stdin is a TTY (or `--interactive` / `-i` is passed), the harness opens a multi-turn read-eval-print loop. Each prompt invokes `runTurn`, persists, and recalls memory naturally across the conversation.

Mode detection:
- `--message <txt>` → one-shot, send and exit (unchanged behavior)
- `--interactive` / `-i` → force REPL even with non-TTY stdin
- TTY stdin + no `--message` → REPL by default
- non-TTY stdin + no `--message` → reads all stdin as one message (legacy pipe path)

### Slash commands

In REPL mode, lines starting with `/` are intercepted by the harness:

```
/help                show this help
/audit [--limit N]   show recent approvals + bank audit for this session
/recall <query>      semantic search over memory
/memory list         shallow list of all memories
/memory stats        memory store stats
/clear               clear screen
/exit | /quit        end the REPL (Ctrl+D also works)
```

These work without a configured LLM provider — useful for inspection-only workflows. The `--policy` flag from the parent invocation is inherited by all slash commands.

### Lazy provider resolution

REPL opens cleanly even without `ANTHROPIC_API_KEY` / `CF_ACCOUNT_ID`+`CF_API_TOKEN`. Slash commands work; sending an actual user message lazily resolves the provider and fails clean if creds are missing. Banner shows `[provider: NOT configured ...]` so the user knows.

### SIGINT semantics in REPL
Same as v0.1.3 one-shot: first Ctrl+C cancels the in-flight turn, second hard-exits. Counter resets between prompts so each turn gets a fresh "first press cancels gracefully".

### Why bump to 0.2.0
This is a real UX shift, not just a feature addition. Pre-0.2.0, `harness chat` was a script-friendly one-shot. Post-0.2.0, the harness is interactively usable as an agent you talk to. The semver-significant change is that `harness chat <id>` (no args) now does something fundamentally different — opens a REPL — instead of erroring.

## [0.1.9] — 2026-05-05

### Bench command — retrieval accuracy regression

`agent-skills-cli` exports `runBench`. We surface it as a `harness` subcommand so retrieval accuracy can be measured against any truth file, with an optional pass/fail threshold for CI gating.

### CLI
- **`harness bench --truth <path> [--threshold N] [--rerank <mode>] [--k N]`** — runs the bench against the subscribed bank using the configured embedder. `--threshold N` (a top-1 accuracy fraction in [0, 1]) gates exit code: `< N` → exit 1, `>= N` → exit 0. Without `--threshold`, the run is informational and always exits 0.
- Output: standard bench summary (top-1 / top-3 / top-K counts and percentages, mean top-1 score, mean margin, elapsed) plus the first 10 top-1 failures showing `expected → got` for each.

### Smoke verified
- Pulled `bench-truth.jsonl` (35 entries) from `agent-skills-pack@v2.2.0`.
- Ran against the live-test bank (7 skills, stub embedder).
- Got top-1 = 22.9% (expected for stub — fnv1a-32 has no semantics; intended as a sanity baseline).
- `--threshold 0.5` → exit 1 with "FAIL — top-1 accuracy 22.9% below threshold 50.0%".
- `--threshold 0.1` → exit 0.

In production with a real embedder (Ollama, Cloudflare Workers AI, OpenAI, transformers.js), top-1 typically lands in 80-95% — the threshold becomes a real regression guard.

### Recommended CI usage (manual / workflow_dispatch)
A reasonable check for a release branch:
```bash
export OLLAMA_BASE_URL=...   # or CF_*, OPENAI_*
harness skills add github.com/MauricioPerera/agent-skills-pack@vX.Y.Z
curl -fsSL https://raw.githubusercontent.com/MauricioPerera/agent-skills-pack/vX.Y.Z/bench-truth.jsonl > truth.jsonl
harness bench --truth truth.jsonl --threshold 0.85
```

Exit 1 if accuracy regresses below 85%. Not added to the default CI workflow because it requires either an embedder service (network/credentials) or a downloaded transformers.js model (~100MB, slow first run). Use `workflow_dispatch` or a release-only job.

## [0.1.8] — 2026-05-05

### AES-256-GCM at rest for sessions + memory

`just-bash-data` already supports encryption at rest; the harness now exposes it as a single, opt-in flag.

### Policy
- New `policy.encryption: { enabled, saltMemory?, saltSession? }`. Default `enabled: false`. Salts are optional namespacing for the underlying PBKDF2 derivation in just-bash-data.
- The key itself is read from **`HARNESS_ENCRYPTION_KEY` env var** — NEVER stored in policy YAML or on disk. When `enabled: true` and the env var is missing, the harness throws at construction with a clear message.

### Wiring
- `SessionStoreOpts` gains `encryptionKey?` and `encryptionSalt?`, forwarded to `createBankBash` for every session bank instance.
- `MemoryStoreOpts` gains the same, forwarded to `createWikiPlugin` for the memory bank instance.
- CLI helper `buildSessionStore(policy)` consolidates the four call sites that constructed session stores; reads + propagates the key.
- CLI's `buildMemoryIfEnabled` likewise propagates the key + salt to memory.

### Smoke (`scratch/live-test-encryption.ts`)
- Wrote a known-secret memory with key A → grep'd every file under the memory dir; **secret not found verbatim** (encryption confirmed at the bytes level).
- Reloaded with key A → recall surfaces the original content exactly.
- Reloaded with a different key → recall returns nothing or throws (no plaintext leak).
- Control: unencrypted store with the same data shows the secret IS findable on disk (encryption is the only thing protecting it).
- 4/4 checks PASS.

### Caveat documented
Encryption is a **one-time decision per bank dir**. Changing the key (or salt) on an existing bank effectively re-keys it — old data becomes unreadable. The key (and salt) need to remain stable for the life of the bank. Back them up.

## [0.1.7] — 2026-05-05

### Compaction (lifts the maxTurns ceiling)

When memory is enabled and compaction is on, `runTurn` slices `session.turns` down to the last `windowSize` entries before passing them to the provider as `input.history`. The dropped turns are NOT lost: they remain in `db turns` (full session audit) AND in memory (auto-persisted as turn-kind records during their original processing). The harness's recall mechanism brings back relevant content from the dropped turns by similarity to the current user message.

This breaks the false trade-off between long sessions and bounded context.

### Policy
- New `memory.compaction: { enabled, windowSize }` config. Default `enabled: false, windowSize: 50`. Validated in `policy.ts` with sane fallback (windowSize must be >= 1).

### Loop
- `runTurn` now slices `session.turns` per the policy when memory is enabled and compaction triggers. A debug line goes to `onThinking` reporting how many turns were dropped: `[compaction: N older turn(s) dropped from active history; recall covers them]`.
- Each persisted Turn entry corresponds to one complete user-message-to-end_turn cycle (`appendTurn` is called once per `runTurn`), so slicing the array gives clean tool_use/tool_result pairing at the boundary — no orphan tool_result blocks reach the provider.

### Smoke
- `scratch/live-test-compaction.ts`: builds a 30-turn session with compaction off, then runs one more turn with compaction on (windowSize=10). Asserts via SpyProvider that:
  - Provider received exactly 10 history entries
  - Oldest is turn 21 (TOTAL - WINDOW + 1)
  - Newest is turn 30
  - Session db has all 31 turns (audit invariant)
  - Memory has all 30 auto-persisted turns
- 5/5 checks PASS.

### What this enables in practice
A session can now run for hundreds of turns without the provider context blowing up. As the conversation drifts, older specifics fade from the verbatim transcript but stay searchable. The agent stays "in scope" via memory recall while the LLM only pays for the active window.

Pair with `policy.limits.maxTurns: <high>` and `compaction.windowSize: <small>` for long-running agents.

## [0.1.6] — 2026-05-05

### Memory CLI surface enrichment
- **`harness search <query> ...`** — alias for `recall`, surfaced under a more discoverable name. Both go through the same code path; `search` matches user vocabulary, `recall` matches the API.
- **`--kind <k>` and `--session <id>` filters** added to recall/search. Lets users narrow retrieval to a specific kind (e.g. only "turn" memories) or session.
- **`harness memory stats`** — prints rootDir, total count, oldest/newest timestamps, breakdown by kind. Quick observability without dumping content.
- **`harness memory export <path>`** — writes all memories (id, title, kind, ts, content) as JSON. Best-effort: content is recovered via recall-by-title; records that don't surface (e.g. extremely long content the recall walker can't reach) get `content: null` and a warning to stderr.

### CLI HELP updated
New surface listed in `--help` output, with `recall` documented as an alias.

### Smoke verified
Created 4 mixed memories (2 fact + 2 turn across 2 sessions); confirmed:
- `memory stats` → correct counts and date range
- `search "packaging"` → finds the relevant turn (similarity 0.479)
- `search --kind fact` → narrows to fact-only matches
- `search --session sess_A` → narrows to one session
- `memory export` → 4 records in JSON, all with content recovered

## [0.1.5] — 2026-05-04

### Cross-session memory (just-bash-wiki integration)
The harness now uses **all four** repos in the stack — wiki was the missing piece.

- **`src/memory.ts`** — new `Memory` interface (`remember` / `recall` / `forget` / `list` / `size`) backed by `just-bash-wiki` with `ReadWriteFs` for disk persistence. Each memory becomes a `wiki source` with kind/sessionId metadata; recall embeds the query and uses `wiki search source_embeddings` for similarity ranking, then enforces an optional `charBudget`. Always returns at least one record even if it exceeds budget (avoids "I have it but the cap hides it").
- **Loop integration** — when `policy.memory.enabled`, `runTurn` recalls relevant memories from the user message **before** invoking the provider and injects them into `systemPrompt` as a "Relevant memories from past turns" block. After `end_turn`, it auto-persists the user message + final assistant text as a turn-kind memory (gated by `policy.memory.persist.autoPersistTurns` + `minMessageLength`). Failures in either path are non-fatal — log to onThinking and continue.
- **Policy schema** — new top-level `memory: { enabled, rootDir, recall: { topK, charBudget }, persist: { autoPersistTurns, minMessageLength } }`. Default `enabled: false` (opt-in). YAML validated by `policy.ts` with per-key fallbacks.

### CLI subcommands
- **`harness recall <query> [--topK N] [--budget N]`** — list memories ranked by similarity to the query.
- **`harness memory list [--kind <k>] [--limit N]`** — shallow listing (id, kind, ts, title).
- **`harness memory forget <id>` / `--kind <k>` / `--session <id>`** — delete by id or bulk by filter.
- **`harness memory remember "<content>" [--kind k] [--session id]`** — explicit fact storage.
- All require `policy.memory.enabled: true` (otherwise exit 78 with a clear hint).

### Tests
- **12 new unit tests in `src/memory.test.ts`** — toy embedder (no live LLM), covering: empty store, similarity ranking, kind filter, sessionId filter, charBudget cap, single-large-record budget exemption, forget by id / kind / sessionId, list with kind filter.
- **`scratch/live-test-memory.ts`** — cross-session smoke (no real LLM): a SpyProvider captures the systemPrompt; verifies that a session-1 turn populates memory and that session-2's systemPrompt INCLUDES the recalled content. **5/5 checks pass.**
- Total: **121 → 133 unit tests** in ~34s.

### Bug fix during P4
- `createMemoryStore` originally constructed `Bash` without an `fs` option, defaulting to `InMemoryFs` — memories vanished on process exit. Fixed by passing `new ReadWriteFs({ root: opts.rootDir })`. Smoke tested across two CLI invocations: `remember` in process A, `recall` in process B both see the data.

### Stack integration after P4
| Repo | Used by harness as of v0.1.5 |
|---|---|
| `agent-skills` (spec) | identity, frontmatter, applicable_when (P6), trust levels |
| `agent-skills-cli` | FileBank, runQuery, runExec, embedders, signature verifiers |
| `just-bash-data` | session storage via `db sessions/turns/approvals` (transitively) |
| `just-bash-wiki` | **NEW: cross-session memory + auto-persist of turns** |

## [0.1.4] — 2026-05-04

### `applicable_when` filter (spec §2.7)
- **`Toolbox.list()` and `Toolbox.resolve()` now apply the spec's `applicable_when` filter** against the host context. Skills declaring `os` / `arch` / `shell_commands_present` / `env_present` / `env_absent` are dropped from the catalog when the host doesn't satisfy them.
- Host context detected lazily on first list/resolve: `detectHost()` (os, arch, env keys) augmented with `detectAvailableCommands(union of subscribed skills' required commands)`.
- New `ToolboxOpts.filterApplicable: boolean` (default `true`) — set false to expose ALL subscribed skills regardless of host fitness.
- New `ToolboxOpts.hostContext?: HostContext` for test injection / explicit override.

### CLI
- **`harness skills list [--all]`** — by default shows only skills applicable to the current host. `--all` shows everything in the bank. When something was filtered out, stderr prints `# N skill(s) hidden by applicable_when filter — pass --all to see them`.

### Tests
- 9 new unit tests in `src/toolbox.test.ts` covering OS / shell command / env_present / env_absent / no-constraints / filter-disabled / mixed-catalog cases. Total: **109/109**.
- Verified end-to-end against `agent-skills-pack@v2.2.0`: on a Windows host without `rg`, `ripgrep-search` (which declares `applicable_when.shell_commands_present: ["rg"]`) is correctly hidden — 6 visible, 7 with `--all`.

### Why this matters
Without this, the LLM could pick a skill that's guaranteed to fail at exec time (e.g., calling `gh` when the GitHub CLI isn't installed). The harness now hides those skills before they reach the model, eliminating a class of unnecessary tool-call failures.

## [0.1.3] — 2026-05-04

### CLI polish
- **`harness version` / `--version` / `-v`** — prints the harness version (hardcoded in lockstep with `package.json`).
- **`harness sessions`** — lists session dirs newest-first by mtime, with a count line on stderr. Empty case prints a friendly message pointing at the sessions root.
- **`harness audit <sessionId> [--limit N]`** — prints session metadata, then approvals from the session's `db approvals` (last N, newest-style ordering), then the bank's recent skill executions (`bank.listAudit`). Skill ids shortened to last path segment for legibility; intent (if recorded by `runExec`) shown clipped to 60 chars.
- **SIGINT handling in `harness chat`** — first Ctrl+C aborts the loop's `AbortSignal` (loop will stop at the next provider event boundary, save what it collected, and return exit 130). Second Ctrl+C hard-exits.
- **Per-subcommand error wrapping** — each subcommand now goes through `withCommandError(name, fn)`. Errors print as `harness <cmd>: <message>` instead of generic `fatal:` traces. Specific case: `loadPolicyOrDefault` translates `ENOENT` to `policy file not found: <path>`.
- **Cleaner "session not found" error** — `session.load(id)` now distinguishes "missing" from "exec error" and throws `session not found: <id>` instead of leaking the bash exit code.
- **Bug fix: dir pollution from typo'd session ids** — `session.load(id)` now `stat`s the per-session dir before constructing a `createBankBash` instance. Without this, `harness audit s_typo` would create an empty bank dir under the sessions root because just-bash's FS creates dirs lazily on first access.
- **HELP rewrite** — added Examples section showing common flows (bootstrap, subscribe pack, force provider, list/resume sessions). Subcommand list reorganized.

### Smokes verified
- All 8 subcommands work against a fresh `~/.harness/sessions/`.
- Bad inputs (`audit nonexistent`, `--policy /tmp/no-such.yaml`, `garbage` subcommand) produce clean, contextualized errors.
- 100/100 unit tests still pass; slice, e2e, cf-driven all green.

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
