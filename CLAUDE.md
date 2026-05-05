# CLAUDE.md

Guidance for future Claude Code sessions opening this repo.

## What this is

`just-bash-harness` — single-agent loop on top of `just-bash` and the `agent-skills` ecosystem. Sandboxed tool execution, derived approval gates, persisted sessions, swappable LLM providers (Anthropic + Cloudflare Workers AI), cross-session memory via `just-bash-wiki`, optional AES-256-GCM at rest, retrieval bench with threshold gating.

Built incrementally across versions v0.1.2 → v0.1.9 (see [CHANGELOG.md](CHANGELOG.md) for the per-release detail). The user is `Mauricio Perera`, who maintains the four upstream repos this harness integrates: `agent-skills`, `agent-skills-cli`, `just-bash-data`, `just-bash-wiki`.

## Read these first, in order

1. **[README.md](README.md)** — what + how to install + minimal quickstart.
2. **[DESIGN.md](DESIGN.md)** — layer contracts, turn protocol, approval matrix. Canonical truth for the architecture.
3. **[CHANGELOG.md](CHANGELOG.md)** — historical context. Each version explains a specific design pivot.
4. **[PROVIDERS.md](PROVIDERS.md)** — how to add a new LLM provider.
5. **[TESTING.md](TESTING.md)** — coverage map, what's NOT unit-tested and why.
6. **[COEVOLUTION.md](COEVOLUTION.md)** — upstream changes proposed; mostly cancelled because the spec already had what was needed.

## Local development

```bash
npm install                          # ~5 min cold (file: deps to local siblings)
npm run typecheck                    # always green
npm run test                         # 133/133, ~30-60s
npm run dev -- --help                # tsx, no build needed
npm run build                        # tsup → dist/cli.js + dist/index.js
node dist/cli.js --help              # built bin

# Smoke scripts (deterministic, no creds)
npm run smoke:slice                  # FileBank + runQuery + runExec
npm run smoke:e2e                    # 5 approval scenarios scripted
npm run smoke:cf-driven              # Gemma-replayed end-to-end

# Smokes requiring live network/creds (manual)
npm run smoke:cf-live                # CF_ACCOUNT_ID + CF_API_TOKEN
```

## Conventions

- **No emojis in code**. The user has feedback on this. Use plain prose in comments.
- **Comments explain WHY**, not WHAT. Don't restate the code. Add comments only when the reader can't deduce intent from names + types.
- **No dead code, no preemptive abstraction**. If a feature wasn't requested, don't add it. Delete unused code aggressively.
- **TypeScript strict mode** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. New code should typecheck without `any` casts.
- **No `child_process`** anywhere in the harness — all skill execution goes through `runExec` which uses `just-bash` internally.
- **Each persisted Turn is one user-message-to-end_turn cycle**. `appendTurn` is called once per `runTurn`. This makes history slicing safe (compaction).
- **Single-quote escape for db/wiki commands**: `s.replace(/'/g, "'\\''")`. There's an `escSingle` helper in session.ts and memory.ts.

## Repo layout (brief)

```
src/
  types.ts                  contracts (DESIGN §3)
  toolbox.ts                FileBank + runQuery + runExec + applicable_when filter
  session.ts                createBankBash-backed db sessions/turns/approvals
  memory.ts                 createWikiPlugin + ReadWriteFs persistent memory
  approval.ts               deriveCategory + gate + TTY prompt
  policy.ts                 YAML loader + DEFAULT_POLICY
  loop.ts                   turn orchestrator + memory recall/persist + compaction
  provider.ts               factory + env auto-detect
  provider-anthropic.ts     Anthropic Messages API adapter
  provider-cloudflare.ts    Workers AI OpenAI-compat (Gemma 4 26B default)
  cli.ts                    entry point — bin: harness
  cli-args.ts               argv parser (extracted for testability)
  index.ts                  public library API
  *.test.ts                 unit tests (cli-args, approval, policy, provider*,
                            toolbox, memory) — 133 total
scratch/
  slice.ts                  smoke: FileBank + runExec + audit + db export
  e2e.ts                    smoke: 5 approval scenarios w/ scripted provider
  e2e-cf-driven.ts          smoke: real Gemma decisions replayed
  e2e-cloudflare.ts         opt-in: live CF (needs creds)
  live-test*.ts             memory / compaction / encryption / pack smokes
  wiki-prototype.ts         reference for direct just-bash-wiki usage
.github/workflows/ci.yml    typecheck + tests + build + 3 smokes
```

## Things that look weird but are intentional

1. **`file:../agent-skills-cli` in package.json** — the user owns the CLI; we depend on the local clone, not the published npm package. This means the sibling must be built (`npm run build` in `D:/repos/agent-skills-cli/`) before installing the harness.
2. **`just-bash` and `just-bash-data` were removed from direct deps in v0.1.1** — they come transitively via `agent-skills-cli`. Then v0.1.5 added `just-bash` and `just-bash-wiki` back as direct deps because memory imports them. So `just-bash-data` is still transitive only.
3. **TypeScript double-resolution of `Bash` type** — `file:` deps make TS see two distinct `Bash` types (one in agent-skills-cli's node_modules, one in our top-level just-bash). Workaround: don't import `Bash` directly in modules that use `createBankBash`; type by inference (`ReturnType<typeof createBankBash>`). See `session.ts`.
4. **stub embedder warning is normal** — `resolveEmbedderFromEnv` throws when no provider creds are configured; the CLI catches and falls back to `createStubEmbedder`. The stderr line is intentional UX.
5. **`harness audit` lazy-creates dirs FIX** — `session.load(id)` calls `stat()` before `bashFor(id)` to avoid creating empty bank dirs from typo'd ids. See v0.1.3 CHANGELOG.
6. **memory uses ReadWriteFs explicitly** — without it, just-bash defaults to InMemoryFs and memories die on process exit. See v0.1.5 CHANGELOG.
7. **CRLF warnings on git commit** are Windows line-ending normalization. Harmless.

## When the user says "adelante"

It means "proceed with your recommendation". They've been delegating heavily across 9 versions. Two rules I learned from this conversation:

- **For features from the agreed roadmap**: yes, proceed. They've already opted in.
- **For external actions (push, publish, modifying their repos)**: ALWAYS ask explicitly. "adelante" without a specific URL/destination is NOT permission for external action.
- **For post-v0 features I'd be adding without prior discussion**: ask before going. Don't gold-plate.

## Testing patterns

- **Unit tests** use `node:test` + `node:assert/strict`. No vitest. Each file exports `test(name, fn)` calls.
- **Each test must clean up**. Use `mkdtemp` for fixtures and `rm` in `try/finally`.
- **Toy embedder** in `memory.test.ts` is the pattern for embedder-dependent tests without network.
- **SpyProvider** in `live-test-memory.ts` and `live-test-compaction.ts` is the pattern for asserting on what a provider receives.

## Git conventions

- Conventional commits with scope: `feat(toolbox):`, `feat(memory):`, `fix(...):`, `chore(...):`, `docs(...):`.
- Co-author tag: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` per session.
- Tags on every release: `v0.1.X`. Annotated, with a one-line message.
- `main` branch only so far. No remote yet.

## What's deliberately NOT done

- No P9 (chains spec multi-skill orchestration). Discussed but deferred as post-v0.
- No npm publish. Not pushed to any remote. The user holds those decisions.
- No interactive REPL for `harness chat`. Each invocation is one-shot; multi-turn requires re-invoking with the same session id.
- No multi-tenant. Single-user assumption is intact.
- No multi-agent. Single-agent loop only.
- No web UI.
