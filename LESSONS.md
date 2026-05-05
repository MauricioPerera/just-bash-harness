# Lessons

Operational doctrines distilled from real bugs. Each one is anchored to the
release where the bug surfaced. Read these before adding any feature that
introduces a new layer between the user and an existing safety mechanism.

These are not hypothetical guidance — every entry is here because we shipped
something that violated it. The goal is to make the next regression visible
in code review (or at the contract / changelog level) instead of after a
post-publish review.

---

## 1. Audit prior invariants when adding orchestration

**Origin: v0.2.3 — chains bypassing the approval gate.**

`v0.2.1` added chains (spec §2.8): a parent skill declares `chains[]`, the
harness runs the parent and then automatically runs each declared step, all
under a single user approval. The runtime sandbox per step still worked
correctly — each step ran inside its own per-skill `runExec` instance with
the same FS scratch, network allowlist, and env scoping as before. The
v0.2.1 changelog said:

> "security isolation is preserved because each step runs in its own sandbox"

That sentence was technically true and operationally misleading. **Runtime
isolation per skill is one safety mechanism. Human-in-the-loop approval is
a separate, equally important safety mechanism.** The chain code path
called `deriveCategory(parent, policy)` with only the parent's metadata.
The chain steps' capabilities (`network`, `filesystem`, `idempotent`,
`signatureStatus`) never entered the calculation. A benign-looking parent —
signed, idempotent, no network — could declare a chain step pointing at a
skill with `network: ["evil.com"]` and the user would never see that step
at the approval prompt. Approve the parent, the whole pipeline runs.

`v0.2.3` fixed it: `deriveCategory` now takes
`chainSkills: readonly ResolvedSkill[]` and computes the union over parent
plus every step. Worst category wins. `derivedFrom` tags each chain-attributed
reason with `chain:<short-id>` so the prompt shows what's being approved.

### Doctrine

> **When adding any orchestration layer (chains, planners, multi-agent,
> parallel execution), enumerate every existing safety invariant the new
> layer touches and reverify each one. Do not assume that "the security
> mechanism still works" because the security mechanism's code didn't
> change. Mechanisms can be bypassed by being routed around.**

### Where this will reappear

Future features that will trigger this doctrine again:

- **Multi-agent / planner-workers** — a planner that decides which worker
  agent to invoke is, by definition, an orchestration layer. Its decisions
  must be subject to approval, not just the workers' tool calls.
- **Parallel skill execution** — if two chain steps run in parallel and
  both write to the same scratch, the FS allowlist invariant could be
  bypassed by their interaction even though each one alone respects it.
- **Skill composition operators** — any "if X then Y" or "for each in
  collection do Z" macro must apply approval over the projected set of
  skills, not the macro itself.
- **Multi-tenant** — a tenancy abstraction sits between user and policy.
  Confirm the policy is loaded under the right tenant identity before any
  approval check.

---

## 2. When a feature reuses existing primitives, enumerate the invariants
   it touches in the changelog and reverify each

**Origin: same v0.2.3 root cause, generalized.**

The chains bug wasn't a careless oversight — it was a side effect of how
the v0.2.1 work was framed. The implementation was correctly described as
"a translation of spec §2.8 to the harness". The code was a faithful
translation. The bug was that translating a feature spec verbatim does not
audit the surrounding system. Spec §2.8 says nothing about approval gates
because it's a feature spec, not a security review.

The v0.2.1 changelog described what shipped in terms of capability ("chains
work"). It did not describe what existing invariants the feature now had to
respect. A reader reviewing the diff for security implications would have
had to know to look — there was no checklist saying "this feature touches
the approval flow, here's the analysis".

### Doctrine

> **A changelog entry for a feature that reuses existing primitives must
> include an "Invariants touched" section: every safety / correctness
> invariant the feature interacts with, and the analysis that confirms each
> still holds. The default in this repo is fail-loud: if the section is
> missing, the review treats the feature as unaudited.**

This is an unusually heavy-weight changelog convention. It is justified by
the cost ratio: writing the section takes minutes, missing the audit costs
an emergency security release. We discovered this by paying the second
cost.

### Concretely, the invariants this repo cares about

When a new feature is being designed, ask whether it touches any of:

- **Approval gate** — `deriveCategory`, the `prohibited / explicit /
  regular` matrix, the override map, the TTY prompt, fail-closed defaults
  on EOF / non-TTY / signal.
- **Sandbox per skill** — `runExec` from `agent-skills-cli` provides FS
  scratch, network allowlist, env scoping. Anything that wraps `runExec`
  (chains, planners, retries) must preserve them.
- **Trust model** — DESIGN §2 partitions content into trusted (user via
  chat) and untrusted (LLM, tool stdout, network responses). Adding a new
  source of strings (a tool that fetches docs, an MCP bridge, a wiki
  recall) requires classifying that source.
- **Persistence boundaries** — `db turns` (per-session audit), `db
  approvals` (per-session approvals), `bank.appendAudit` (cross-session
  forensics), memory (`wiki source`), and the future `db approval_stats`.
  A feature that adds a new write path must say which collection it writes
  to and what the read patterns are.
- **Encryption** — `policy.encryption.enabled` is a bank-wide one-way
  decision today. Any feature that reads or writes outside the encrypted
  bank dirs has to be accounted for.
- **`maxWallclockMs` and turn budgets** — features that wait (rate-limit
  retries, parallel chain steps, summary calls) must say how they interact
  with the policy budget.
- **AbortSignal propagation** — Ctrl+C should close upstream sockets, not
  wait for stream drain. Any new I/O must accept the signal.

### Where this will reappear

The doctrine fires every time a feature looks innocent because the code is
a "natural extension":

- **Policy override DSL** — if we add a richer override language than
  the current `id → category` map, that DSL touches the approval gate.
- **Skill installation hooks** — if a skill can declare a post-install
  script, that script becomes a new untrusted execution surface that bypasses
  `runExec`'s sandbox unless we route it through one.
- **Memory-driven tool results** — if memory recall ever feeds material
  back as a `tool_result` block, that material crossed a trust boundary
  that the trust model didn't account for at write time.

---

## 3. Tag and tarball must reference the same commit

**Origin: v0.2.5 → v0.2.6 — git tag at one commit, npm tarball built from
another.**

`v0.2.5` was the first version pushed to the npm registry. The publish-prep
changes (drop `private: true`, `file:` deps to semver, repo metadata,
`.gitignore` `.npmrc`) landed in commit `f72a6b0` *after* the `v0.2.5` git
tag at `bbd6da1`. The two trees were not the same. A consumer reading
`v0.2.5` from git could not reproduce the published tarball.

`v0.2.6` was a no-code-change release whose only purpose was to put the
git tag and the tarball at the same commit.

### Doctrine

> **Never create a release tag before the publish-prep is committed.
> If `package.json` or `npm publish` configuration needs to change for
> publication, that change is part of the release commit, not a follow-up.**

### Operational rule

The release flow is exactly:

1. Commit feature work and CHANGELOG entry.
2. Verify CI green on that commit.
3. Bump `package.json` version + matching `HARNESS_VERSION` in source (or
   import from `package.json` so this is a single edit) + CHANGELOG header.
4. Commit the bump.
5. Tag the bump commit.
6. Build, publish, push tag.

The bump commit and the tag and the tarball are the same tree. There is no
out-of-band step.

---

## 4. Duplicate facts in source will desynchronize

**Origin: v0.2.5 — `HARNESS_VERSION` constant in `src/cli.ts` stayed at
`"0.2.4"` while `package.json` read `"0.2.5"`. Same root cause repeated
between v0.2.4 → v0.2.5 and v0.2.5 → v0.2.6.**

Every place where the same fact (version, max-tokens, default model,
sentinel value) is duplicated is a synchronization bug waiting to fire. The
duplication doesn't cause a runtime error — it causes the user to see one
value somewhere and a different value elsewhere, and the gap to be
discovered weeks later.

### Doctrine

> **One source of truth per fact. If the build system can resolve the fact
> at compile time (TypeScript JSON modules, Vite `define`, build-time
> codegen), prefer that to a manually-synced constant.**

`v0.2.7` fixed this specifically by importing the version from `package.json`:

```ts
import packageJson from "../package.json" with { type: "json" };
const HARNESS_VERSION = packageJson.version;
```

Required dropping `rootDir: "src"` from `tsconfig.json` so the JSON import
resolves outside the source tree. tsup inlines the value at build time.

### Where this will reappear

- Default model identifiers (`claude-opus-4-7`, `@cf/google/gemma-4-26b-a4b-it`)
  exist in provider files. If they ever exist in two places, they will drift.
- Fact tables in CHANGELOG, README, DESIGN can drift; the LOC claim that
  stayed at `~1700` for many releases is the same anti-pattern in docs.

---

## How to add to this file

A new entry is justified when:

1. A bug shipped in a release.
2. A retrospective identified a doctrine that, if held, would have caught
   it before merge.
3. The doctrine generalizes — a future feature in the same class would
   benefit from the rule.

The format is consistent: **Origin (which release)**, what shipped that
violated it, **Doctrine (one sentence in a blockquote)**, where it will
likely reappear. Brevity matters; this file is read at design time, not
incident time.
