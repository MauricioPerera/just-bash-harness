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
- **The `--target` choice list for `harness rekey` lived in three places
  (`RekeyTarget` type, HELP text, CHANGELOG bullet) when the `skills`
  target was added in `de3da02`; only the type and HELP got updated.
  The CHANGELOG bullet went stale until the post-publish audit caught
  it.** Operational corollary: when extending an enum-shaped fact
  (choice list, status set, command verbs), grep the codebase + docs
  for occurrences of every existing value before committing. If the
  count > 2, refactor to a single source.

---

## 5. A doctrine applies the moment it is authored

**Origin: v0.3.0 — doctrine #2 (above) was written in commit `713d2c8`
roughly an hour before v0.3.0 shipped, and was NOT applied to v0.3.0's
own changelog. Applied retroactively in `de3da02` along with a written
acknowledgement of why retroactive application matters.**

The v0.3.0 release closed five tracked issues in a consolidated commit.
Each of those features touched at least one existing safety invariant
(persistence boundaries, trust model, encryption, approval gate,
provider input channel). Doctrine #2 says: enumerate those invariants
in the changelog and reverify each. The doctrine had been authored
exactly one commit prior. It was not applied.

The defensive reading was: "the doctrine is for future work; v0.3.0
was closing pre-tracked issues." That reading is **the comfortable
exit that makes operational doctrines aspirational**. If a doctrine
authored at time T applies starting at T+1 release, then any author
of a doctrine can implicitly grant themselves a one-release exemption
on the very thing they're codifying. The doctrine becomes a thing
that someone else must follow first.

The retroactive application in `de3da02` set the opposite precedent:
the moment a doctrine exists in the repo, it applies. The five
features of v0.3.0 each got an "Invariants touched" subsection added
post-publish, with the explicit framing that "this section is added
retroactively, as a precedent: the doctrine applies the moment it
exists."

### Doctrine

> **A doctrine added to LESSONS.md applies to the current release in
> flight, not just to future releases. If a feature already shipped
> within the same release window violated the new doctrine, retrofit
> the changelog or release notes with the analysis the doctrine
> demands. The cost of one retroactive application is small; the
> cost of letting the first violation pass uncontested is that every
> subsequent violation has a defensible precedent.**

### Why this matters specifically for LESSONS.md

This file is unusual in the repo: it's authored *because* of bugs,
not as planning artifact. Every entry was a hindsight. That means
the natural tempo is "ship → review → write doctrine → next release
applies it." That tempo allows exactly one violation per doctrine
before enforcement, and that violation is the same release that
prompted the doctrine. Without doctrine #5, every new entry here
gets a free first violation.

The corollary: when you author a new doctrine, immediately scan the
in-flight or just-shipped release for cases that the doctrine would
have caught. If any exist, file them as retroactive notes — either
in the changelog (as v0.3.0 did) or as a separate post-publish
commit (as this one does for itself).

### Where this will reappear

- **The next time a doctrine is added.** This is the explicit case.
- **Soft "guideline" language that can be reinterpreted as
  aspirational.** If a doctrine reads "should consider X" rather
  than "must enumerate X", the comfortable exit is wider. The
  blockquoted doctrine sentence in each entry should be a directive,
  not a recommendation.
- **Cross-repo doctrines that depend on upstream packages.** If a
  similar doctrine ever lands in `agent-skills-cli` or `just-bash-data`,
  the same logic applies — the moment it exists upstream, downstream
  consumers should sweep their in-flight code for violations rather
  than wait.

### Note on this entry's own scope

This doctrine is itself a meta-application. It was authored after
the post-0.3.0 audit cycle (`v0.3.0` → `35a1862` → `de3da02` →
`84c5f38`) demonstrated the pattern in practice: doctrine #2 was
written at 13:46, violated at 14:38 (v0.3.0), retroactively applied
at 14:52 (de3da02), and audited again at 15:27 (84c5f38). The
trajectory across those four commits — write → violate → retro →
audit — is the case study. Adding doctrine #5 after-the-fact is
itself an instance of doctrine #5 applying to itself: the lesson
exists, so it gets codified now, not at "the next release."

---

## 6. Documentation drift is invisible to internal review; only external rendering exposes it

**Origin: post-0.3.0 audit session — seven cases of stale documentation
detected within ~3 hours, all attributable to the same anti-pattern
and none caught by prior internal review.**

NotebookLM (a generic doc-to-diagram tool) was run against the repo on
2026-05-05 to produce architectural visualizations for documentation
purposes. Each diagram it produced revealed a distinct case where the
canonical documentation had drifted from the actual code. The diagrams
were not wrong — they were faithful to the prose they read. The prose
itself was stale.

| # | Doc location | Drift | Fix commit |
|---|---|---|---|
| 1 | `README.md` "Architecture in one diagram" | ~v0.1.4 vintage; missed memory layer (added v0.1.5), approval_stats (v0.3.0), redact step in pipeline (v0.3.0); listed approval as one label among four "cross-cutting" rather than discrete node; "just-bash + just-bash-data" presented as peers eliding that one runs on top of the other | `11ee068` |
| 2 | `CHANGELOG.md` v0.3.0 rekey bullet | `--target sessions\|memory\|all` listed; the actual list extended to include `skills` in the same-day post-publish commit, but the bullet was not updated | `84c5f38` |
| 3 | `DESIGN.md` §4 turn protocol | Approval gate buried as sub-steps `3.b–3.f` of a "for each tool_call" block — technically correct but visually invisible to a reader treating the section as a flow; missing memory recall, compaction (slice + summary), per-call rationale, redact pass, chain step union, approval_stats write | `fbc2258` |
| 4 | `DESIGN.md` §4.2 compaction | `**TBD.** v0: hard cap turns. Post-v0 candidates...` — vigente nine releases past v0.1.7's slice + recall and v0.3.0's optional rolling summary | `fbc2258` |
| 5 | `DESIGN.md` §3.3 + §5 approval | `deriveCategory` signature shown as the v0.1 single-skill version, missing the `chainSkills` parameter and chain union logic shipped in v0.2.3 as a security fix; approval matrix table evaluated as single-skill rather than over-the-union | `e49347d` |
| 6 | `DESIGN.md` (no canonical section for encryption) | Encryption + rekey behavior fragmented across five locations (policy schema, CLI HELP, CHANGELOG v0.1.8 + v0.3.0, README Trade-offs, rekey.ts module header) with no single authoritative DESIGN section; opt-in default (`enabled: false`), bank-coverage asymmetry (skills bank stays plaintext), and rekey caveats (mv→mv non-atomic window, hardcoded collection list, <60s lock best-effort) all elided | `a67c728` |
| 7 | `DESIGN.md` §6 filesystem layout | "Two separate root dirs" listed when the repo has three banks (skills + sessions + memory); collections listed as `sessions/turns/approvals` when `approval_stats` (v0.3.0) and `sources` (memory) also exist; no command-to-bank mapping, leading external readers to confuse same-session turn replay (`db turns find`) with cross-session memory recall (`harness recall`) | (this commit) |

The drift is invariant across release tempo. The harness shipped an
average of one feature release per major commit cycle, and every
release that touched a subsystem updated `CHANGELOG.md` and the local
module — but `DESIGN.md`, `README.md`'s architectural diagram, and
the cross-references between sections were systematically left behind.
Internal review never caught this because the reviewer (the maintainer
or a same-context reader) automatically fills the gaps with knowledge
not present in the prose. An external reader (a new contributor, a
doc-rendering tool, an evaluator deciding whether to adopt the repo)
sees only what the prose says — and produces output that exposes the
drift cleanly.

The seven cases above were caught in a single audit session because a
generic external tool was pointed at the repo for the first time. The
maintainer had been writing changelogs and code comments correctly the
whole time; the gap was that no equivalent verification step existed
for the architectural docs.

### Doctrine

> **Every feature commit must end with a grep of DESIGN, README, and
> CHANGELOG for the subsystem it touched, and update any prose, table,
> diagram, or signature that no longer matches the code. Every
> pre-release must additionally render the architectural docs through
> an external doc-to-diagram tool (NotebookLM, Mermaid generator,
> mkdocs preview, or equivalent) and compare the output against the
> code; mismatches are drift to fix before publish, not after. Drift
> between docs and code is invisible to internal review because the
> reviewer fills gaps with context the external reader cannot see.
> Only mechanical, context-free rendering exposes the drift.**

### Why this is heavy-weight, and why it's still worth it

The cost of the per-commit grep is small (seconds), but the cost of
the pre-release external rendering is real (minutes to render +
minutes to read the output critically + minutes to fix discovered
drift). For a single-maintainer project with releases every few weeks,
the rendering step is on the order of an hour per release.

The case for paying that hour:

- Drift caught at release time costs the same hour to fix as drift
  caught after release. The difference is whether external readers
  see it first or you do.
- Each drift case caught means one less "the docs say X but the
  code does Y" support interaction, which costs more than the audit.
- For a project that explicitly positions itself as
  "maintainer-grade software for a specific ecosystem" (per the
  README's "Intended audience" block), the docs ARE the
  product surface for evaluators. Drift in that surface costs
  adoption decisions.

### Where this will reappear

- **Adding any new collection to any bank.** §6's collection list
  drift was a special case of doctrine #4 (duplicate facts). When
  `approval_stats` was added in v0.3.0, the §6 list wasn't updated.
  Any future collection (e.g. a hypothetical `audit_log` for §4.3
  redact diagnostics, or an `embeddings_cache` for memory) will
  trigger this unless the per-commit grep catches it.
- **Changing any signature with a default-arg evolution.**
  `deriveCategory` gained `chainSkills?: readonly ResolvedSkill[]`
  in v0.2.3 with default `[]`, so every call site stayed compatible
  — and DESIGN's signature stayed unchanged because the code didn't
  technically need it to. Future signature evolutions with
  defaults (e.g. provider getting a new optional param) will
  silently drift the same way.
- **Promoting any "TBD post-v0" or "future work" placeholder when
  the work actually ships.** §4.2's "TBD post-v0" survived nine
  releases. Any prose that says "TBD" or "future" or "not yet"
  is a drift candidate the moment the underlying capability lands.
- **Anywhere a fact lives only in CHANGELOG.** CHANGELOG is
  history, not spec. If a behavior change lands in CHANGELOG and
  is referenced from CHANGELOG only, the spec doesn't reflect it.
  Encryption + rekey behavior was the case here: documented in
  CHANGELOG v0.1.8 + v0.3.0 + rekey.ts header but absent from
  DESIGN until §4.4 + §4.5 were added in `a67c728`.
- **Architectural diagrams older than two minor releases.** The
  README architecture diagram was ~v0.1.4 vintage when fixed at
  v0.3.0+. Anything visual that hasn't been touched in two minor
  releases should be assumed stale until verified.
- **Deliberate asymmetries between structurally similar features.**
  Where two features look symmetric (two providers, two sinks, two
  modes, two storage backends) but operate asymmetrically in some
  dimension (test infrastructure, capability scope, default
  behavior), document the asymmetry as **deliberate** in prose,
  not just by absence of mention. Otherwise external rendering
  tools will synthesize the missing half by symmetry —
  hallucinating parity that does not exist. Concrete case from
  the post-doctrine-#6 audit: a NotebookLM diagram of the testing
  infrastructure produced a phantom "Anthropic (Opt-in)" live
  smoke entry purely by symmetry with the real Cloudflare live
  smoke. The rendering tool synthesized the entry because both
  providers exist and one had a smoke; the absence of explicit
  prose stating "no live Anthropic smoke and here's why" let the
  hallucination through. Fixed in `TESTING.md` with a "Live LLM
  smoke asymmetry" subsection that names the asymmetry as
  deliberate and explains the reasoning. The general rule:
  **structural symmetry plus operational asymmetry requires
  explicit deliberateness statements**, or rendering tools will
  paper over the gap.

### How to apply mechanically

For per-commit:

```bash
# After staging your feature changes
SUBSYSTEM="approval"  # or "memory" / "encryption" / etc.
git grep -i "$SUBSYSTEM" -- DESIGN.md README.md CHANGELOG.md
# Read each hit; update any that no longer matches the code.
```

For pre-release:

```bash
# Render the docs through a tool you don't control (the point is
# that the rendering is mechanical, not reviewed by you).
# Compare the output against current code. Diff → drift.
```

A future automation candidate: a CI job that runs a Mermaid generator
or similar against `README.md` + `DESIGN.md` and fails if the produced
diagrams reference fewer subsystems than the code has modules. Not
implemented; tracked as a future improvement.

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
