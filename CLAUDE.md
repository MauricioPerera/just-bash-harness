# CLAUDE.md

Guidance for future Claude Code sessions opening this repo.

## What this is

`just-bash-harness` — single-agent loop on top of `just-bash` and the `agent-skills` ecosystem. Sandboxed tool execution, derived approval gates (with chain-aware union since v0.2.3), persisted sessions, swappable LLM providers (Anthropic + Cloudflare Workers AI with retry/backoff), cross-session memory via `just-bash-wiki` (with optional rolling LLM summary at compaction since v0.3.0), opt-in AES-256-GCM at rest with `harness rekey` rotation, retrieval bench with threshold gating, secret redaction at persistence boundaries (Phase 1), and approval-fatigue metrics with `harness audit --suggest-overrides`.

Built incrementally across versions v0.1.2 → v0.3.0 (see [CHANGELOG.md](CHANGELOG.md) for the per-release detail). The user is `Mauricio Perera`, who maintains the four upstream repos this harness integrates: `agent-skills`, `agent-skills-cli`, `just-bash-data`, `just-bash-wiki`.

**Published**: as `just-bash-harness` on the npm registry since v0.2.5. The binary on PATH is named `harness` (not `just-bash-harness`) — see README's Install section for the package-vs-bin distinction.

**Repo state**: `main` branch lives at https://github.com/MauricioPerera/just-bash-harness with full release history (tags v0.1.2 → v0.3.0), GitHub releases backfilled per tag, and an open issue tracker for post-v0.3.0 deuda.

## Read these first, in order

1. **[README.md](README.md)** — what + how to install + minimal quickstart (with `npm install -g just-bash-harness` flow + dev clone-and-link flow separated explicitly).
2. **[DESIGN.md](DESIGN.md)** — layer contracts, turn protocol, approval matrix. Canonical truth for the architecture. Now includes §4.3 (redact pipeline), §4.4 (encryption at rest with opt-in callout), §4.5 (rekey), §6.3 (per-collection enumeration).
3. **[CHANGELOG.md](CHANGELOG.md)** — historical context. Each version explains a specific design pivot. v0.2.5 → v0.2.6 has the tag/tarball alignment story; v0.3.0 has "Invariants touched" sections per feature (retro-applied per LESSONS doctrine #5).
4. **[PROVIDERS.md](PROVIDERS.md)** — how to add a new LLM provider. Includes asymmetry table (CF retry hand-rolled vs Anthropic delegated to SDK).
5. **[TESTING.md](TESTING.md)** — coverage map, what's NOT unit-tested and why. Includes "Live LLM smoke asymmetry" subsection explaining why CF has live smoke and Anthropic deliberately doesn't.
6. **[LESSONS.md](LESSONS.md)** — operational doctrines distilled from real bugs. Six numbered doctrines as of v0.3.0 + post-publish audits, each anchored to a release that surfaced the pattern.
7. **[COEVOLUTION.md](COEVOLUTION.md)** — upstream changes proposed; mostly cancelled because the spec already had what was needed.

## Local development

```bash
npm install                          # ~5 min cold (deps from npm registry since v0.2.6)
npm run typecheck                    # always green
npm run test                         # 258/258 unit tests, ~30-60s
npm run dev -- --help                # tsx, no build needed
npm run build                        # tsup → dist/cli.js + dist/index.js
node dist/cli.js --help              # built bin

# Smoke scripts (deterministic, no creds)
npm run smoke:slice                  # FileBank + runQuery + runExec
npm run smoke:e2e                    # 5 approval scenarios scripted
npm run smoke:cf-driven              # Gemma-replayed end-to-end
npm run smoke:summarize-disabled     # regression guard for compaction.summarize=false
npm run smoke:chain-approval         # union-of-categories approval gate (chain skills)

# Plus 5 more live-test smokes wired in CI:
#   live-test-memory.ts          cross-session memory recall
#   live-test-compaction.ts      history slicing under compaction
#   live-test-encryption.ts      AES-256-GCM at rest verified at the bytes level
#   live-test-chains.ts          chains (multi-skill orchestration)
#   live-test-hermes.ts          Hermes <tool_call> parser via captured SSE replay

# Plus 1 manual smoke not run in CI (subscribes a real public pack):
#   live-test-real-pack.ts       end-to-end pack subscription via runSync

# Smokes requiring live network/creds (manual, NOT in CI)
npm run smoke:cf-live                # CF_ACCOUNT_ID + CF_API_TOKEN
```

## Conventions

- **No emojis in code**. The user has feedback on this. Use plain prose in comments. (Emojis in user-facing CLI output that the user explicitly asked for are fine.)
- **Comments explain WHY**, not WHAT. Don't restate the code. Add comments only when the reader can't deduce intent from names + types.
- **No dead code, no preemptive abstraction**. If a feature wasn't requested, don't add it. Delete unused code aggressively.
- **TypeScript strict mode** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. New code should typecheck without `any` casts.
- **No `child_process`** anywhere in the harness — all skill execution goes through `runExec` which uses `just-bash` internally.
- **Each persisted Turn is one user-message-to-end_turn cycle**. `appendTurn` is called once per `runTurn`. This makes history slicing safe (compaction).
- **Single-quote escape for db/wiki commands**: route through `src/util-escape.ts` exporting `escSingle`. Four modules use it (session, memory, approval-stats, rekey); after issue #10 they all import the same helper. See LESSONS doctrine #4.

## Repo layout (brief)

```
src/
  types.ts                  contracts (DESIGN §3)
  toolbox.ts                FileBank + runQuery + runExec + applicable_when filter
  session.ts                createBankBash-backed db sessions/turns/approvals
  memory.ts                 createWikiPlugin + ReadWriteFs persistent memory
  approval.ts               deriveCategory + gate + TTY prompt (chain-aware union)
  approval-stats.ts         per-skill counters + suggester (issue #3 v0.3.0)
  policy.ts                 YAML loader + DEFAULT_POLICY
  policy-overrides.ts       --allow-unsigned + future per-invocation policy mutations
  loop.ts                   turn orchestrator + memory recall/persist + compaction (slice + optional summary)
  provider.ts               factory + env auto-detect
  provider-anthropic.ts     Anthropic Messages API adapter (SDK-delegated)
  provider-cloudflare.ts    Workers AI OpenAI-compat with hand-rolled SSE + retry/backoff (Gemma 4 26B default)
  redact.ts                 secret pattern scrubbing (Phase 1) at persistence boundaries
  rekey.ts                  harness rekey command — encryption key rotation per bank
  util-escape.ts            single source of truth for escSingle
  util-encryption-error.ts  CLI error wrapper for AES-GCM key-mismatch (issue #18)
  skill-init.ts             harness skill init scaffolder (issue #19 Phase 1)
  cli.ts                    entry point — bin: harness
  cli-args.ts               argv parser (extracted for testability)
  index.ts                  public library API
  *.test.ts                 15 test files, 258 unit tests total (cli-args, approval,
                            approval-stats, loop, memory, policy, policy-overrides,
                            provider, provider-anthropic, provider-cloudflare, redact,
                            rekey, skill-init, toolbox, util-encryption-error)
scratch/
  slice.ts                  smoke: FileBank + runExec + audit + db export
  e2e.ts                    smoke: 5 approval scenarios w/ scripted provider
  e2e-cf-driven.ts          smoke: real Gemma decisions replayed
  e2e-cloudflare.ts         opt-in: live CF (needs creds)
  live-test-*.ts            memory / compaction / encryption / chains / hermes /
                            summarize-disabled / chain-approval / real-pack smokes
  wiki-prototype.ts         reference for direct just-bash-wiki usage
.github/workflows/ci.yml    typecheck + tests + build + 10 smokes (every push, every PR)
```

## Things that look weird but are intentional

1. **Package name `just-bash-harness`, bin name `harness`.** The npm package and the binary on PATH are deliberately different (npm `bin` field controls the executable name independently). All CLI examples use `harness <subcommand>`, not `just-bash-harness <subcommand>`. README opens with a callout stating this.
2. **Registry semver for siblings since v0.2.6.** `package.json` resolves `@rckflr/agent-skills-cli@~2.3.0`, `just-bash@^2.14.3`, `just-bash-wiki@^1.2.1` from npm. Pre-v0.2.6 the harness used `file:../*` paths to local clones; that flow is preserved as the dev workflow only (see "Install for development" in README).
3. **TypeScript double-resolution of `Bash` type** — pre-v0.2.6 (when `file:` deps were active) TS saw two distinct `Bash` types (one in agent-skills-cli's node_modules, one in our top-level just-bash). Workaround: don't import `Bash` directly in modules that use `createBankBash`; type by inference (`ReturnType<typeof createBankBash>`). See `session.ts`. Post-v0.2.6 with registry deps this is less of an issue but the workaround is preserved.
4. **stub embedder warning is normal** — `resolveEmbedderFromEnv` throws when no provider creds are configured; the CLI catches and falls back to `createStubEmbedder`. The stderr line is intentional UX.
5. **`harness audit` lazy-creates dirs FIX** — `session.load(id)` calls `stat()` before `bashFor(id)` to avoid creating empty bank dirs from typo'd ids. See v0.1.3 CHANGELOG.
6. **memory uses ReadWriteFs explicitly** — without it, just-bash defaults to InMemoryFs and memories die on process exit. See v0.1.5 CHANGELOG.
7. **REPL is interactive since v0.2.0**. `harness chat <id>` without `--message` opens a multi-turn read-eval-print loop with slash commands (`/help /audit /recall /memory /clear /exit`). One-shot mode is preserved via `--message <txt>` or piped stdin.
8. **CRLF warnings on git commit** are Windows line-ending normalization. Harmless.
9. **CI clones agent-skills-cli + just-bash-wiki as siblings** in `.github/workflows/ci.yml` and builds them before testing the harness, even though `npm ci` in the harness resolves from npm registry. Either vestigial from pre-v0.2.6 file:deps or an intentional sibling breakage detector — tracked in issue #13 for investigation.

## When the user says "adelante"

It means "proceed with your recommendation". They've been delegating heavily across the v0.1 → v0.3 development cycle. Three rules:

- **For features from the agreed roadmap**: yes, proceed. They've already opted in.
- **For external actions (push, publish, modifying their repos)**: ALWAYS ask explicitly. "adelante" without a specific URL/destination is NOT permission for external action.
- **For post-v0 features I'd be adding without prior discussion**: ask before going. Don't gold-plate.

The user has approved (and explicitly invited) extensive iterative work via "adelante" patterns when an action plan has been proposed concretely first.

## Testing patterns

- **Unit tests** use `node:test` + `node:assert/strict`. No vitest. Each file exports `test(name, fn)` calls.
- **Each test must clean up**. Use `mkdtemp` for fixtures and `rm` in `try/finally`.
- **Toy embedder** in `memory.test.ts` is the pattern for embedder-dependent tests without network.
- **SpyProvider** in `live-test-memory.ts` and `live-test-compaction.ts` is the pattern for asserting on what a provider receives.
- **Full `runTurn` is integration-tested via smokes**, not unit tests — too many moving parts (provider, toolbox, session, approval gate, memory) to mock cleanly without diluting signal. See `loop.test.ts`'s opening comment.

## Git conventions

- Conventional commits with scope: `feat(toolbox):`, `feat(memory):`, `fix(...):`, `chore(...):`, `docs(...):`.
- Co-author tag: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` per session.
- Tags on every release: `v0.X.Y`. Annotated, with a one-line message.
- `main` is the only branch. Pushed to `origin` (https://github.com/MauricioPerera/just-bash-harness).

## What's deliberately NOT done

- No P9 (chains spec multi-skill orchestration beyond the v0.2.1 chains feature). Future enhancements to chains are post-v0 unless explicitly requested.
- No multi-tenant. Single-user assumption is explicit and intentional, documented in README "Trade-offs that landed but still have caveats".
- No multi-agent. Single-agent loop only. Multi-agent debate (LangGraph / CrewAI / AutoGen patterns) is out of scope by design.
- No web UI. CLI / TTY / REPL only. CHANGELOG `0.2.0` discusses this explicitly.
- No live Anthropic LLM smoke (deliberate — Anthropic SDK has its own tests). See `TESTING.md` "Live LLM smoke asymmetry" for the rationale.
- No `harness rekey --cleanup-backups` command yet. Backup directories accumulate after rekey; cleanup is the user's job per current docs. Tracked in issue #15.
- No skills bank encryption. Decided 2026-05-06 (Path B in `CONTRACT-skills-bank-encryption.md`, GitHub issue #26): the asymmetry where sessions + memory are AES-256-GCM at rest but the skills bank is not is a deliberate design choice with explicit threat-model rationale, not an oversight. See DESIGN §4.4 "Why the skills bank stays plaintext", README "Trade-offs that landed but still have caveats", and LESSONS doctrine #6 sub-clause B Case C. Revisitable if a real consumer with stricter threat model (multi-user host, shared CI) appears.
- No formal v1 roadmap. CHANGELOG references "promote `createBankBash` to STABLE before v1.0" but nothing else is enumerated as v1-blocking.

## Open issues (post-v0.3.0)

The post-v0.3.0 cleanup queue (#6 through #16, ~11 issues spanning chain-approval smoke, sessions encryption smoke, `rekey.ts` unit tests, doc drift, escSingle centralization, randomUUID consistency, CI siblings investigation, REPL bash-lifecycle, `harness rekey --cleanup-backups`, encryption-key silent-change docs) **was fully closed in earlier sessions**. Don't re-open issues #6-#16 — they each have a closing commit referenced from the issue body.

The currently-open work is the **roadmap-driven contracts in `D:/repos/ailibro/CONTRACT-*.md`**, tracked as GitHub issues #17–#26. State as of 2026-05-06 after the agentic cycle that processed #18, #19, #21, #23 Phase 1, #26, plus partial drift sweep on #9:

| Issue | Title | State |
|---|---|---|
| #17 | Repositioning — operator narrative as primary framing | 🟢 READY (needs maintainer voice for prose) |
| #18 | Encryption error wrapping (CLI side) | ✅ shipped commit `10d0687`; issue stays open until next release tag |
| #19 | `harness skill init` scaffolder + 'first skill in 5 min' guide | ✅ Phase 1 shipped commit `4fa1551`; issue stays open until next release tag. Pre-flight outcome: Path A viable, no upstream coordination — see `CONTRACT-skill-init-command.md` § Pre-flight outcome. The "5-min guide" doc deliverable is residual (separate sub-task). |
| #20 | Curated `ops-essentials@v1` skill pack (15-20 signed skills) | 🟢 Phase 0 (curation) landed in `D:/repos/ailibro/CONTRACT-ops-essentials-skills-list.md` proposing 16 specific skills; authoring phase pending maintainer (needs GPG key, repo creation decisions, real Linux host for smokes). NOT autonomous work. |
| #21 | `harness do <task>` — one-shot ops mode | ✅ shipped commit `c6253fa`; issue stays open until next release tag |
| #22 | `n8n-ops@v1` pack (REST CRUD + MCP path 2 validation case) | 🟢 READY (depends soft on #20 authoring phase) |
| #23 | Suggester blacklist for destructive skills | ✅ Phase 1 shipped commit `5bfac8c` (Option 1 + Option 3 hybrid; pattern blacklist in `approval-stats.ts`). Phase 2 (`destructive: true` frontmatter field upstream) is separate eventual contract. Issue stays open until next release tag. |
| #24 | MCP provider as second-class citizen | 🟡 DEFERRED until at least one curated skills pack ships, per maintainer prioritization 2026-05-06 |
| #25 | `harness rekey` lockfile mutex + atomic promote | 🟡 DEFERRED to the implementation window per maintainer prioritization |
| #26 | Skills bank encryption decision | ✅ Path B (deliberate asymmetry, no implementation) decided + docs shipped commit `980ca1d`. Issue stays open as a trail; maintainer can close after next release tag. |

When you pick a 🟢 READY issue to work on, the file path + line number references in each issue body and the linked CONTRACT-*.md should give you the exact starting point. The LESSONS.md doctrines apply to any fix — particularly #2 (enumerate invariants touched in changelog), #6 (grep DESIGN/README/CHANGELOG/CLAUDE.md after the fix), and #4 (avoid creating new duplicate facts).
