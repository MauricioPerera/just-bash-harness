# Just-Bash Harness — Design Contract

Status: **v0 contract complete** · 2026-05-04

This document defines the layer contracts, turn protocol, and approval matrix for an agentic harness built on top of:

- [`vercel-labs/just-bash`](https://github.com/vercel-labs/just-bash) — sandbox runtime (external)
- [`agent-skills`](https://github.com/MauricioPerera/agent-skills) **v1.2.0 STABLE** — spec
- [`@rckflr/agent-skills-cli`](https://github.com/MauricioPerera/agent-skills-cli) **v2.3.0** — reference impl
- [`just-bash-data`](https://github.com/MauricioPerera/just-bash-data) **v1.1.2** — db + vec
- [`just-bash-wiki`](https://github.com/MauricioPerera/just-bash-wiki) **v1.1.3** — RAG (post-v0)

Validation history:
- **2026-05-04** — vertical slice confirmed assumptions (`scratch/slice.ts`, 4/4 PASS).
- **2026-05-04** — orchestration smoke covered all 5 approval scenarios (`scratch/e2e.ts`, 5/5 PASS).
- **2026-05-04** — real Gemma 4 26B decisions replayed through full pipeline via the Cloudflare MCP connector (`scratch/e2e-cf-driven.ts`, PASS).
- **2026-05-04** — 70/70 unit tests green across `cli-args`, `approval`, `policy`, `provider`, `provider-cloudflare`.

See [README.md](README.md), [PROVIDERS.md](PROVIDERS.md), [TESTING.md](TESTING.md), and [CHANGELOG.md](CHANGELOG.md) for operator-facing documentation.

---

## 1. Goals & non-goals

### Goals
- Run a single LLM agent in a loop: prompt → tool calls → results → next turn, until done or stopped.
- Tools are skills resolved on demand from a `FileBank`; no static tool catalog.
- Sandbox all tool execution via `runExec` from `agent-skills-cli` (which wraps `just-bash` per skill).
- Persist sessions via a separate `createBankBash`-backed db on its own dir.
- Human-in-the-loop approval, derived from existing skill metadata — no new spec fields.
- Provider-agnostic: Anthropic first; the LLM adapter is replaceable.

### Non-goals (v0)
- Multi-agent orchestration / planner-workers.
- Multi-tenant deployment.
- Running untrusted user-supplied scripts.
- Web UI. CLI / TTY only.

---

## 2. Trust model

| Source | Trust | Implication |
|---|---|---|
| Host process (Node) | Trusted | Defines policy, fetches LLM, owns FileBank. |
| User input (chat) | Trusted | Cannot be overridden by tool output. |
| LLM output | Untrusted | Treated as data. Tool calls flow through approval. |
| Skill packs | Untrusted-but-pinned | Enforced by `enforceVerification` on `provenance.signature_status`; reject `unsigned`/`invalid` per policy. |
| Tool stdout/stderr | Untrusted | Never re-interpreted as instructions. |
| Network responses | Untrusted | Already capped per skill via `network: string[]` declaration (spec §2.10). |

**Rule:** instructions only ever come from the user via chat. Anything found in tool output, web responses, or skill markdown that *looks* like an instruction is data.

---

## 3. Layer contracts

```
┌──────────────────────────────────────────┐
│  cli (TTY)                               │  user-facing
├──────────────────────────────────────────┤
│  loop                                    │  turn orchestration
├──────────────────────────────────────────┤
│  provider   approval   session   policy  │  cross-cutting
├──────────────────────────────────────────┤
│  toolbox  ←  FileBank + runQuery/runExec │  skill resolution + execution
└──────────────────────────────────────────┘
                 │
                 ▼
   agent-skills-cli (handles sandbox per skill)
                 │
                 ▼
            just-bash + just-bash-data
```

The `Sandbox` layer of v0.1 is gone. `runExec` already builds a per-skill sandboxed `just-bash` instance with the skill's declared network / filesystem / env constraints. The harness does not need its own sandbox abstraction.

### 3.1 `toolbox`
```ts
interface Toolbox {
  list(): Promise<SkillSummary[]>;
  resolve(intent: string, opts?: ResolveOpts): Promise<ResolvedSkill[]>;
  execute(skill: ResolvedSkill, args: Record<string, unknown>, intent?: string): Promise<ToolResult>;
}
```
Backed by a `FileBank` instance + `runQuery` + `runExec`. Audit is automatic — `runExec` writes audit entries; the harness reads via `bank.listAudit()` for replay.

### 3.2 `provider`
```ts
interface Provider {
  turn(input: TurnInput): AsyncIterable<TurnEvent>;
}
type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; id: string; skill: SkillId; args: unknown }
  | { type: 'stop'; reason: StopReason };
```
v0: Anthropic Messages API with prompt caching + streaming.

### 3.3 `approval`
```ts
interface ApprovalGate {
  check(action: PendingAction): Promise<ApprovalDecision>;
  record(record: ApprovalRecord): Promise<void>;
}

// Pure function — no I/O. Inputs are existing spec fields.
// Since v0.2.3: takes optional chain steps. Worst category over the
// union [skill, ...chainSkills] wins.
function deriveCategory(
  skill: ResolvedSkill,
  policy: Policy,
  chainSkills?: readonly ResolvedSkill[],
): DerivedCategory;
```

Category is derived, not declared. The evaluation runs **four rules in strict precedence order**. The first rule that matches returns immediately and short-circuits all subsequent rules. Override is checked FIRST. Default `regular` is the LAST possible outcome.

1. **Override (FIRST — short-circuits all other rules).** If `policy.skills.overrides[skill.id]` or `policy.skills.overrides[skill.shortId]` is set, return that category immediately. The signature gate, the capability heuristics, AND the default rule never execute. The override can map to `regular`, `explicit`, OR `prohibited` — it is the user's authoritative classification for this skill, NOT a fallback or last-resort bypass. A user who has audited a skill (whether to trust it more or distrust it more) writes an override entry; the harness then never re-derives that skill's category.

2. **Signature gate over the union (SECOND — only if no override matched).** If `policy.signature.require_signed: true`, scan every skill in the union `[skill, ...chainSkills]`. If ANY has `signatureStatus !== "valid"`, return `prohibited`. The "not valid" check catches **three failure states**: `unsigned` (skill never validated), `invalid` (signature failed verification), and `unverified` (validation pending or skipped). All three trigger the gate. The diagram-friendly shorthand `!signed` elides this distinction; in code it's the three-state inequality. The reason record names which skill in the chain triggered (e.g. `chain:foo signature:unsigned`) so the approval prompt shows the cause.

3. **Capability heuristics over the union (THIRD — only if signature passed).** Scan every skill in the union `[skill, ...chainSkills]` for any of these triggers:
   - `network.length > 0` → escalate to `explicit`
   - `filesystem.length > 0` → escalate to `explicit`
   - `idempotent === false` → escalate to `explicit`

   If any trigger fires for any skill in the union, return `explicit` with all reasons attributed (`network:N` for the parent, `chain:foo network:N` for chain steps).

4. **Default `regular` (LAST — only if all other rules passed without firing).** All skills in the union are signed, all have empty `network[]`, all have empty `filesystem[]`, all have `idempotent: true`. Auto-allow under the default policy matrix.

The harness uses inputs that all come from existing spec fields — no new fields required. The signals table below is **also in evaluation order** (top to bottom = first-checked to last-checked):

| Order | Signal | Effect on category |
|---|---|---|
| 1st | `policy.skills.overrides[id]` or `[shortId]` is set | the override value wins (any of `regular | explicit | prohibited`); short-circuits |
| 2nd | Any skill in `[parent, ...chains]` has `signatureStatus !== "valid"` (any of `unsigned`, `invalid`, `unverified`) AND `policy.signature.require_signed: true` | `prohibited` |
| 3rd | Any skill in `[parent, ...chains]` has `network[]` non-empty | escalate to `explicit` |
| 3rd | Any skill in `[parent, ...chains]` has `filesystem[]` non-empty | escalate to `explicit` |
| 3rd | Any skill in `[parent, ...chains]` has `idempotent === false` | escalate to `explicit` |
| 4th | else | `regular` |

#### Chain step union (v0.2.3 — security fix)

**Every rule above except #1 (override) evaluates over the union, not just the parent.** Pre-v0.2.3, `deriveCategory` evaluated only the parent's metadata. A parent skill that declared `chains[]` could silently smuggle privileged steps past the human approval prompt: a benign-looking parent (signed, idempotent, no network → category `regular` → auto-allow) declares a chain step pointing at a skill with `network: ["evil.com"]`, the user sees no prompt, the network call goes through. The runtime sandbox per-step still applied — but the human-in-the-loop gate was bypassed.

Since v0.2.3, every gate (signature, capabilities) scans `[parent, ...chainSkills]` as a single set. The `derivedFrom` array tags chain-attributed reasons with `chain:<short-id>` so the approval prompt shows where each capability came from. See `LESSONS.md` doctrine #1.

#### Unknown chain step → synthetic worst-case

A `chains[]` entry whose `skill` identity is NOT resolvable in the bank (typo, missing dependency, malicious crafted reference) is synthesized by `loop.ts` as a worst-case ResolvedSkill before being passed to `deriveCategory`:

```ts
{ ...parent, id: stepId, signatureStatus: "unsigned",
  network: ["*"], filesystem: ["*"], idempotent: false }
```

The union then forces `prohibited` regardless of policy permissiveness. This is a **defense-in-depth** layer — even if a user disables `require_signed` (e.g. via `--allow-unsigned` for development), the synthetic step's worst-case capabilities still escalate the category. Verified by the `unknown chain step still escalates when signature gate is off` test in `approval.test.ts`.

#### A note on terminology: override is FIRST, not "fallback"

The override map is sometimes informally called an "escape hatch" because it lets the user override the heuristic derivation when they disagree with it. Despite the name, the override is **checked FIRST in the evaluation order**, not as a last-resort fallback. The user's explicit choice supersedes the signature gate, the capability heuristics, AND the default. The "escape" is from the heuristic ladder entirely, not from a single rule's outcome. Diagrams and renderings that interpret "escape hatch" as "evaluated last as fallback" are reading the metaphor literally rather than mechanically — the doctrine #6 sub-clause on locally-correct-but-globally-ambiguous prose names exactly this failure mode.

Categories the model claims are ignored; only categories the harness derives (or the user's override map dictates) reach the gate.

### 3.4 `session`
```ts
interface SessionStore {
  create(opts: SessionOpts): Promise<SessionId>;
  load(id: SessionId): Promise<Session>;
  appendTurn(id: SessionId, turn: Turn): Promise<void>;
  snapshot(id: SessionId): Promise<SnapshotRef>;
  resume(id: SessionId): Promise<Session>;
}
```
Backed by a dedicated `createBankBash({ bankDir })` on a session-only dir. Collections: `sessions`, `turns`, `approvals`. `snapshot` runs `db <coll> export` for each collection and returns a single combined blob ref. `resume` re-imports.

The skills FileBank and the session bash instance live on **separate dirs**, never share state.

### 3.5 `policy`
Declarative config. Loaded once at session start, immutable for the session.
- Skill subscription list.
- Approval matrix — per category → `'allow' | 'deny' | 'ask'`.
- Resource limits (max turns, max tool calls per turn, max wallclock).
- Signature requirement (`require_signed: boolean`).
- Override map (skill id → forced category).

The policy does NOT need its own network/filesystem allowlist: each skill's declarations in its frontmatter are enforced by `runExec` automatically.

### 3.6 `loop`
The only stateful orchestrator. Owns the turn protocol (§4). Talks to all other layers but layers do not talk to each other except through it.

---

## 4. Turn protocol

A **turn** is one round-trip with the LLM. A **session** is a sequence of turns sharing one `Toolbox` and one session bash instance.

The protocol has TWO loops: an outer loop that runs once per `runTurn` call (memory recall + compaction + persistence) and an inner loop that iterates while the model emits `tool_use` stop reasons.

```
┌── runTurn(sessionId, userMessage) ─────────────────────────────────┐
│                                                                    │
│  ── once per call ──────────────────────────────────────────────── │
│  (1) load session; check maxTurns budget                           │
│  (2) memory.recall(userMessage)        → memoryBlock                │
│  (3) compaction (if memory.compaction.enabled):                    │
│        a. slice session.turns to last windowSize → activeHistory   │
│        b. if compaction.summarize.enabled AND turns dropped:       │
│             extra provider.turn() with dropped turns               │
│             → compactionSummaryBlock; persist as memory            │
│             kind=compaction-summary                                │
│  (4) build base TurnInput:                                         │
│        systemPrompt = base + compactionSummaryBlock + memoryBlock  │
│        history = activeHistory                                     │
│                                                                    │
│  ── inner loop: while stop_reason == "tool_use" ─────────────────── │
│  (5) provider.turn(input, signal) yields events:                   │
│        text → collected; thinking → collected;                     │
│        tool_call → calls[] (rationale snapshotted at this moment); │
│        stop → finalStop                                            │
│  (6) for each tool_call:                                           │
│        a. resolved = toolbox lookup by skill id                    │
│        b. chainSkills = resolve declared chain steps               │
│             (unknown identities → synthetic worst-case)            │
│        c. category = deriveCategory(resolved, policy, chainSkills) │
│        d. action = { skillId, category, args, rationale,           │
│                      derivedFrom }                                 │
│  (7) APPROVAL GATE:                                                │
│        a. decision = approval.check(action)                        │
│        b. if 'ask' → prompt user (TTY); fail-closed on             │
│             non-TTY/EOF/signal                                     │
│        c. if 'deny' → synthesize denial ToolResult                 │
│             (with friendly remediation text when reason            │
│             contains 'signature:')                                 │
│        d. record decision in session approvals + bank-level        │
│             approval_stats                                         │
│  (8) if 'allow':                                                   │
│        a. result = toolbox.execute(resolved, args, intent)         │
│             → runExec → just-bash sandbox per skill                │
│        b. scrubbed = scrubToolResult(result)                       │
│             → secrets redacted before result reaches               │
│             persistence or next provider call                      │
│        c. push scrubbed into nextResults                           │
│  (9) feed nextResults to step (5) as toolResults; iterate          │
│                                                                    │
│  ── once per call (after inner loop terminates) ───────────────── │
│  (10) appendTurn(session, turn) — single persist per runTurn,      │
│         keeps tool_use/tool_result pairing clean                   │
│  (11) memory.remember(user + assistant text) if autoPersistTurns   │
│         AND finalStop == "end_turn" AND length >= minMessageLength │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

The outer loop is once-per-`runTurn`; only steps (5)-(9) repeat. Memory recall and compaction do not re-run between iterations — each `runTurn` is a complete user-message-to-end_turn cycle, with `appendTurn` called once at (10), which is what makes history slicing safe (no orphan tool_result blocks at compaction boundaries).

### 4.1 Persisted `Turn`
```ts
type Turn = {
  id: string;
  ts: string;
  input: { user?: string; toolResults?: ToolCallResult[] };
  output: {
    text: string;
    toolCalls: ToolCall[];
    thinking?: string;
    stopReason: StopReason;
  };
  approvals: ApprovalRecord[];
};
```
There is no `fsRef` field anymore — runExec's per-skill scratch is ephemeral by design. Persistent state lives in `db` collections inside the session bash, snapshotted via `db export`.

`ToolResult.redacted?: number` (added in 0.3.0) records how many secret patterns the redact pass scrubbed from stdout/stderr. `undefined` means "not scrubbed" (legacy or pre-redact path); `0` means "scrubbed, found nothing"; `> 0` means matches happened. Audit queries that filter on redactions should use `>= 1`, not truthy.

### 4.2 Compaction

Implemented across two releases. Configuration on `policy.memory.compaction`:

- **Slice (v0.1.7)**: when `compaction.enabled` and `session.turns.length > windowSize`, the loop slices `session.turns` to the last `windowSize` entries before passing them as `input.history`. Dropped turns remain in `db turns` (full audit) AND in memory (auto-persisted as `kind: "turn"` records during their original `runTurn`). Recall covers them by similarity to the current user message.

- **Rolling summary (v0.3.0, opt-in)**: when `compaction.summarize.enabled`, on each compaction event the harness makes an EXTRA `provider.turn()` call against the dropped turn block, asking for a structured digest ("user intent / decisions made and tools called with key outcomes / open threads"). The result is prepended to subsequent system prompts as `## Earlier conversation digest` and persisted to memory as `kind: "compaction-summary"`. Capped at `summarize.maxTokens` output and 50K chars input (with a `[... truncated for summary call ...]` marker if exceeded). The summary call uses `availableTools: []` so it cannot recurse.

- **Strict-additive guarantee**: with `summarize.enabled: false`, behavior is byte-identical to v0.1.7 (slice + recall, no extra provider call, no compaction-summary memory). Guarded by the `smoke:summarize-disabled` regression check in CI.

### 4.3 Trust pipeline for tool output

Every `ToolResult` produced by `toolbox.execute` passes through `scrubToolResult` before reaching ANY persistence sink or the next provider call. The order of sinks is:

1. `nextResults[]` in the inner loop → next `provider.turn()` as `tool_result` blocks (Anthropic) or role:tool messages (OpenAI-compat). The LLM never sees the raw token.
2. `appendTurn` at (10) → `db turns` collection in the session bank. The audit trail never sees the raw token.
3. `memory.remember` at (11) → wiki `sources` collection. Cross-session memory never sees the raw token.

The pattern set is conservative (AWS access keys, GitHub tokens by all four prefixes, Slack `xox*-`, JWT triplet shape with 8-char floor, PEM private-key blocks). Tuned for low false-positive rate over typical skill output. Phase 2 (policy-driven config + per-skill opt-out) is documented as deferred but not implemented; for now, a skill that legitimately handles secret material has its output redacted.

The redact pass is a **transform**, not a gate — it does not block execution, it only sanitizes the result on its way to persistence. The approval gate is the only mechanism that blocks a tool call.

#### Redaction marker format: `[REDACTED:<kind>:<len>]`

**Important: the replacement marker is NOT a generic `[REDACTED]`.** Each match is replaced with a structured marker that preserves two operationally useful primitives:

```
Input:   "aws_access": "AKIAIOSFODNN7EXAMPLE"
Output:  "aws_access": "[REDACTED:aws-access-key:20]"

Input:   Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
Output:  Authorization: Bearer [REDACTED:jwt:148]

Input:   -----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN...\n-----END PRIVATE KEY-----
Output:  [REDACTED:pem-private-key:1726]
```

The two preserved fields:

- **`<kind>`** — which pattern caught the secret. Values match `RedactionPattern.kind`: `aws-access-key`, `github-token`, `github-pat`, `slack-token`, `jwt`, `pem-private-key`. An operator filtering `db turns` for "what kind of secret was scrubbed in this session?" needs the kind. A bare `[REDACTED]` loses this.
- **`<len>`** — character length of the original match. An operator distinguishing "40-char token" from "1700-char PEM block" needs the length. Useful for triage in audit forensics.

Forensic queries against the audit trail rely on this format. **Renderings or summaries that show the marker as a generic `[REDACTED]` are losing operational primitives** — the format is structured by design. The unit tests in `src/redact.test.ts` assert the exact format including `kind` and `len`.

#### Phase 1 (current) vs Phase 2 (deferred)

Phase 1 (v0.3.0) is what's described above: a fixed conservative pattern set, applied uniformly to every `ToolResult`. Phase 2, deferred at issue-tracking time and not on the roadmap, would add:

- `policy.redaction` config block for user-supplied additional patterns.
- Per-skill opt-out (a skill that legitimately handles JWTs can declare it in frontmatter and bypass the scrubber).
- Generic high-entropy patterns and env-style assignments (`KEY=value`), gated behind policy because the false-positive rate is too high without per-skill opt-out.

Until Phase 2 lands, a skill returning legitimate secret material has its output redacted with no way to opt out.

### 4.4 Encryption at rest

> ⚠️ **OPT-IN, NOT DEFAULT.** `policy.encryption.enabled` defaults to `false`. The harness ships unencrypted; the user must explicitly enable it AND set `HARNESS_ENCRYPTION_KEY`. Diagrams or summaries that present "AES-256-GCM" as if it were always-on are wrong — the algorithm is the mechanism *when enabled*, not the default state.

> ⚠️ **COVERAGE IS ASYMMETRIC.** Even when `enabled: true`, the **skills bank is NOT encrypted**. Only sessions and memory accept a key. The `db approval_stats` collection (skills bank, since v0.3.0) lives in plaintext regardless of policy. See the "Scope" subsection below for the table.

#### Mechanism

- AES-256-GCM via `just-bash-data` (transitively, through `createBankBash` from `agent-skills-cli`).
- Key read from the `HARNESS_ENCRYPTION_KEY` environment variable. **Never** stored in policy YAML, on disk, or in argv — when `policy.encryption.enabled: true` and the env var is missing, the harness throws at construction time with a clear message.
- Optional salts (`policy.encryption.saltMemory`, `saltSession`) namespace the PBKDF2 derivation in just-bash-data. Defaults are used if absent. Salts must remain stable for the life of the bank — changing them is equivalent to changing the key (data becomes unreadable).

#### Scope (asymmetric — important)

Three banks exist; encryption coverage is **not** uniform:

| Bank | Path | Encryption when `enabled: true`? |
|---|---|---|
| Sessions | `policy.paths.sessionsRoot/<sessionId>/` | **Yes** — `db sessions/turns/approvals` all encrypted |
| Memory | `policy.memory.rootDir` | **Yes** — wiki `sources` collection encrypted |
| Skills | `policy.paths.skillsBankDir` (default: agent-skills-cli's `defaultBankRoot()`) | **No** — `FileBank` does not take a key today; `db approval_stats` lives in plaintext alongside skill metadata |

The asymmetry is a consequence of `FileBank` (skills) being a different code path from `createBankBash` (sessions + memory). A user who enables encryption expecting "everything at rest" should be aware that the skills bank — including the `approval_stats` collection added in v0.3.0 — is NOT covered. If/when the skills bank ever takes a key, `harness rekey --target skills` is already wired (see §4.5) to migrate `approval_stats` along with anything else stored there.

#### Why the skills bank stays plaintext (deliberate, with caveats)

Decision recorded 2026-05-06: the asymmetry is **deliberate and permanent** for the foreseeable future, not a gap awaiting closure. The threat-model rationale:

- An attacker with read access to the skills bank dir (`~/.config/agent-skills/` typical path) typically also has access to the skill source code stored there. The source code leaks far more than `approval_stats` does. Encrypting `approval_stats` while leaving the skill code in plaintext does not reduce the attack surface in proportion to the implementation cost.
- The same local-attacker access usually reaches `HARNESS_ENCRYPTION_KEY` itself, since env vars are inherited by user-level processes and readable via `/proc/<pid>/environ` to the same UID. Encryption that depends on a key the attacker can also read is theater, not protection.
- Extending FileBank to accept a key requires upstream coordination with `agent-skills-cli`, plus a one-time migration for every existing skills bank. The work is not blocked technically but is not justified by the current threat model.

**The known limitation we accept**: `approval_stats` is **behavioral data** — it reveals which skills the user approves, how often, when they say deny. In a narrow threat model where an attacker has read access to the skills bank but NOT to the skill source code or session content (e.g. shared-host scenarios with per-user dir isolation that a co-user can bypass through a separate vector), this leaks operational patterns. We acknowledge this and accept it. The asymmetry is named here so anyone evaluating the harness for that threat model can decide whether to mitigate externally (e.g. file-system-level encryption of the skills dir at the OS layer, separate from `policy.encryption.enabled`).

**Future revisitation criterion**: if a real consumer of `FileBank` appears with a stricter threat model (e.g. multi-user host where users genuinely should not see each other's behavioral data, or a shared CI environment with tenant isolation requirements), the decision is revisited and Path A (extend FileBank to accept a key) becomes the upgrade. Until that signal exists, Path A is speculative work and is not on the roadmap. See `CONTRACT-skills-bank-encryption.md` (in the strategy repo) for the full decision record.

#### One-way decision (without the rekey command)

Per CHANGELOG `0.1.8`: changing the key (or salt) on an existing bank effectively re-keys it — existing data becomes unreadable. Pick a key once per scope and back it up, OR use `harness rekey` (§4.5) to migrate explicitly.

#### What "becomes unreadable" actually looks like at runtime

When `HARNESS_ENCRYPTION_KEY` changes between two invocations against the same bank without going through `harness rekey` first, the symptom is a **loud failure, not silent data corruption**. Specifically:

- `db <coll> find` calls executed by the harness against the per-session bank (or memory bank) propagate the underlying `just-bash-data` decryption error as a non-zero exit code with stderr text from the AES-GCM authentication-tag mismatch.
- The harness layer surfaces this as a session-load failure or memory-recall failure, depending on which code path triggered the read.
- **The data on disk is intact.** Only the current key cannot decrypt it. Setting `HARNESS_ENCRYPTION_KEY` back to the original value restores access without requiring `harness rekey`.

What this means operationally:

- If you see "session not found" or "decryption failed" errors after changing your key environment variable, the first thing to check is `HARNESS_ENCRYPTION_KEY` — not whether the data is corrupt.
- The harness does NOT silently return empty results for an encrypted bank read with the wrong key. It fails the read.
- If the original key is genuinely lost (not just temporarily set to the wrong value), the data cannot be recovered. This is the design intent of AES-GCM at rest: lose the key, lose access. No backdoor.

What the harness could do better but currently does not:

- Wrap the `db` exit-code-3 + AES-tag-mismatch stderr with a more helpful CLI message that names `HARNESS_ENCRYPTION_KEY` explicitly. Today the user sees the raw error and has to know to check the env var.
- Validate the key on the first read of a session (e.g. `harness resume <id>`) and surface "this session was encrypted with a different key" as a distinct error class from "session not found".

Both improvements are tracked as deuda; see issue #16 for the planned wrapper.

### 4.5 Key rotation: `harness rekey`

Closes the "one-way decision" caveat above (added in v0.3.0).

#### Flow per bank dir

```
1. Construct two Bash instances: one with OLD key, one with NEW key.
2. Export each known collection from OLD-key bank → JSON-lines tmp file.
3. Initialize sibling staging dir <dir>.rekey-staging-<rand> with NEW key.
4. Insert each doc from tmp file into staging dir.
5. rename(<dir>, <dir>.rekey-backup-<ts>)
6. rename(<dir>.rekey-staging-<rand>, <dir>)
7. Delete tmp files. Backup left in place for user cleanup.
```

#### Invariants and limits

- **Per-target collection lists are hardcoded.** `["sessions", "turns", "approvals"]` for sessions banks; `["sources"]` for memory; `["approval_stats"]` for skills. Adding a new collection requires updating `src/rekey.ts`. This is doctrine #4 territory ("duplicate facts will desynchronize") — `db` doesn't expose `--list-collections` today, so the alternative would be filesystem walk + heuristic.
- **`--dry-run` does steps 1-2 only.** Validates that the OLD key correctly decrypts every collection without touching original storage. Does NOT validate that the NEW key would round-trip — for that, run a real (non-dry) rekey on a backup copy.
- **mv → mv window is sub-second but NOT strictly atomic.** Between `rename(<dir>, backup)` and `rename(staging, <dir>)`, the original path doesn't exist for a brief moment. On local FS with journaling this is negligible; on NFS / fsync-deferred / network filesystems this could fail visibly.
- **Concurrent process detection is best-effort, not a lock.** The command refuses to run if any target dir was modified <60s ago. This is a heuristic to catch "another `harness chat` is running"; it is NOT mutex enforcement. The only safe way to rekey is offline (no other harness invocations against the same bank).
- **Stops on first error.** Remaining bank dirs stay encrypted with the old key (safe state — partial rekey is impossible). The user fixes the underlying issue and re-runs.
- **Backups are kept indefinitely.** `<dir>.rekey-backup-<ts>` directories accumulate per rekey. User is responsible for cleanup AFTER verification that new key works.
- **Keys must come from env vars.** `--from-env <varname>` and `--to-env <varname>`, never `--from <literal-key>`. Argv would expose keys via `ps`. The CLI explicitly rejects literal-key flags.

#### Targets

```
harness rekey --from-env OLD --to-env NEW [--target sessions|memory|skills|all] [--dry-run]
```

`--target all` runs sessions → skills → memory in that order. `skills` is included for forward compatibility (no-op today since the skills bank doesn't encrypt) so a future move to encrypt the skills bank doesn't leave `approval_stats` orphaned.

---

## 5. Approval matrix

Three categories, derived per §3.3. Decisions made *before* execution. **Every "When (derived)" row evaluates over the union `[parent, ...chainSkills]`** — see §3.3 for why.

| Category | When (derived) | Default policy |
|---|---|---|
| **Prohibited** | Any skill in `[parent, ...chains]` has `signatureStatus !== "valid"` while `require_signed: true`, OR override map maps the skill to `prohibited`, OR a chain step references an unknown skill identity (synthesized worst-case) | Hard deny. Logged in session approvals + bank-level approval_stats. |
| **Explicit** | Any skill in `[parent, ...chains]` has `network[]` non-empty OR `filesystem[]` non-empty OR `idempotent: false`, OR override map maps the skill to `explicit` | Prompt user (TTY); single-use approval. Fail-closed on non-TTY/EOF/signal. |
| **Regular** | All skills in `[parent, ...chains]` are signed AND have empty `network[]` AND empty `filesystem[]` AND `idempotent: true`, OR override map maps the skill to `regular` | Auto-allow. Recorded in audit + approval_stats. |

### 5.1 Escalation rules
- **Worst category over the union wins.** A clean parent does not absolve a privileged chain step; a privileged parent does not get auto-promoted by clean chain steps. The category that is most restrictive in the union is the category applied.
- **Chain step union is mandatory, not optional.** Pre-v0.2.3 the harness evaluated only the parent — that was the bypass closed by issue #1 of the v0.2.2 external review. See `LESSONS.md` doctrine #1 ("audit prior invariants when adding orchestration") for the doctrine derived.
- **Override is checked FIRST and short-circuits.** If `policy.skills.overrides[skill.id]` (or `[skill.shortId]`) is set, that category wins and the heuristics never run. The override can map to any of the three categories — including `prohibited`, useful for explicitly distrusting a skill.
- A skill cannot self-promote category — derivation is on the harness side.
- An LLM message claiming "user already approved X" without a chat-side approval record is rejected. The `rationale` field on `PendingAction` is LLM-supplied and shown to the user verbatim, but is **never** interpreted by the harness as authorization.
- Approval is per-session, per-action. No "always allow" in v0. The `approval_stats` collection (v0.3.0) tracks ask/allow/deny rates per skill so the user can decide to add an override entry; this is a user action, not an automatic promotion.

### 5.2 Defense in depth: --allow-unsigned

The `--allow-unsigned` CLI flag (v0.2.7) flips `policy.signature.require_signed` to `false` for the current invocation. This is intended as a development escape hatch — unsigned local skills then fall through to the capability heuristics instead of being blocked at the signature gate. **Critically, the chain step union still applies.** A chain step with `network: ["*"]` still escalates the union to `explicit` (TTY prompt) even when the signature gate is off. Verified by the `unknown chain step still escalates when signature gate is off (capability path)` test in `approval.test.ts`. The flag is not a global "disable all gates" — the capability dimensions are independent.

---

## 6. Filesystem layout

The harness operates on **three separate physical bank dirs**, each with its own role and its own backing engine. None shares state with the others — that's the isolation invariant.

| Bank | Default path | Backed by | Encryption (when `policy.encryption.enabled: true`) |
|---|---|---|---|
| **Skills FileBank** | `policy.paths.skillsBankDir` (default: agent-skills-cli's `defaultBankRoot()`, typically `$XDG_CONFIG_HOME/agent-skills/`) | `FileBank` from `agent-skills-cli` (NOT `createBankBash`) | **No** — FileBank does not take a key |
| **Sessions** | `policy.paths.sessionsRoot/<sessionId>/` per session (default: `~/.harness/sessions/<sessionId>/`) | `createBankBash` per session — one bash instance per session | **Yes** |
| **Memory** | `policy.memory.rootDir` (default: `~/.harness/memory/default/`) | `createWikiPlugin` over `createBankBash` (i.e. just-bash-wiki on top of just-bash-data) | **Yes** |

```
~/.config/agent-skills/        ← Skills FileBank (skill metadata + indexes)
  ├── (FileBank-managed files)
  └── db approval_stats        ← per-skill counters (v0.3.0; bank-level, not per-session)

~/.harness/sessions/           ← Sessions root (one subdir per session)
  └── s_<id>/                  ← createBankBash instance per session
      ├── db sessions          ← session metadata document (one row)
      ├── db turns             ← turn-by-turn audit (rehydrates session history)
      └── db approvals         ← per-session approval records

~/.harness/memory/default/     ← Memory bank (wiki-backed)
  ├── (just-bash-wiki internals: pages, indexes, vec embeddings)
  └── db sources               ← memory records: turn-kind + fact-kind +
                                  compaction-summary-kind (v0.3.0)
```

`runExec` per-skill scratch directories are ephemeral — they live under whatever temp root just-bash chooses for the per-skill `Bash` instance, get torn down when the skill exits, and the harness never sees them.

There is no in-memory `MountableFs` to design — the CLI handles it per skill.

### 6.1 Which command touches which bank

A common confusion (and one that prior NotebookLM-rendered diagrams demonstrated) is that "rehydrating context" can mean two unrelated things — same-session turn replay vs cross-session memory recall. They live in different banks, accessed by different commands, with different semantics.

| Command | Reads from | What it does |
|---|---|---|
| `harness new` | sessions root | Creates a new session dir, inserts an initial `db sessions` doc |
| `harness resume <id>` | sessions/<id>/ | Re-opens a session bank; loads its turns into in-memory `Session` |
| `harness chat <id>` | sessions/<id>/ + memory + skills | Full turn loop: reads turns from session, recalls cross-session memory, executes skills from the FileBank |
| `harness audit <id>` | sessions/<id>/ approvals + bank.audit | Per-session approvals; cross-session execution audit |
| `harness audit --suggest-overrides` | skills bank `db approval_stats` | Reads the **bank-level** counters added in 0.3.0; nothing from sessions |
| `harness recall <q>` / `harness search <q>` | memory bank `db sources` | Cross-session semantic recall via wiki search — this IS "transversal memory" |
| `harness memory list \| forget \| stats \| export \| remember` | memory bank | Memory CRUD; never touches sessions |
| `harness skills list \| add` | skills FileBank | Subscribed packs; never touches sessions or memory |
| `harness rekey --target sessions\|memory\|skills\|all` | rotates encryption key (per §4.5); skills target is no-op today |
| `db turns find '{}' --sort ts:1` (low-level) | **only the current session's** `db turns` | NOT cross-session — replays one session's history |
| `db <coll> export / import` (low-level) | any bank | JSON snapshots; useful for migration or backup, NOT for fatigue metrics |

The takeaways for tooling and documentation:

- **"Rehydrate context"** in this repo can mean `harness resume` (load one session) OR `harness recall` (cross-session semantic search). They're disjoint. Use the precise verb.
- **Approval-fatigue metrics** come from `harness audit --suggest-overrides` reading `db approval_stats` in the **skills** bank. They do NOT come from session-level approvals or from db export/import.
- **Cross-session ("transversal") memory** lives in the memory bank only. The session bank is per-session by design — knowing "what happened in session A" while running session B requires the memory bank.

### 6.2 Isolation invariants

- The three banks **never share documents**. A skill ID never appears in a session's `db turns`; a session ID never appears in skills' `db approval_stats`; a memory record's source never references a session document directly (it's stored as text under `sessionId` metadata for filtering).
- A compromise of one bank does not leak the others. Encryption keys are scoped per bank where applicable (sessions and memory accept keys; skills doesn't take one — see §4.4 for the asymmetry).

### 6.2.1 Bash instance lifecycle

`createSessionStore` caches one `Bash` instance per `SessionId` in an in-memory `Map<SessionId, BashInstance>`. Each `Bash` is a child-process holder via `createBankBash` → `just-bash`, with associated file handles and OS resources. The cache is per-process, lives for the lifetime of the `SessionStore` object, and grows monotonically as new sessions are touched.

For one-shot CLI flows (`harness new`, `harness chat <id> --message ...`, `harness audit <id>`), the cache lifetime is bounded by process exit and the OS reclaims the resources — no explicit cleanup is needed.

For long-running flows that touch many sessions over time — `harness chat <id>` REPL with `/audit other-id` slash commands, future daemon-style hosts, programmatic embedders — the cache can accumulate. **Use `SessionStore.dispose(id?)` to evict cached bashes** (added in issue #14):

- `dispose()` (no arg): evict ALL cached bashes, returns the count evicted. Idiomatic on REPL exit or on host shutdown.
- `dispose(id)` (specific id): evict one session's bash, returns 0 or 1. Idiomatic after slash-command operations against a non-current session.

The CLI's REPL implementation (`cli.ts cmdChat`) calls `dispose()` on REPL exit. Programmatic embedders running long sessions should call `dispose()` periodically or at shutdown.
- The session bank is **per-session**, not "the sessions bank". Each session is its own `createBankBash` instance with its own dir; deleting one session never affects another.

### 6.3 Collections per bank (full enumeration)

This section enumerates every collection in every bank explicitly, one heading per collection. The intent is to give external readers (humans and doc-to-diagram tools) hooks at the prose level that match the actual storage layout. ASCII trees and bullet lists tend to get compressed by rendering tools; explicit per-collection sub-headings survive that compression. If a collection is added or removed in a future release, this section is the canonical place to update FIRST — the diagrams and the rest of §6 follow from here.

#### Skills FileBank — `db approval_stats`

Per-skill counters tracking how many times each skill was asked, allowed, or denied at the approval gate. **Bank-level** scope (not per-session) — counts accumulate across all sessions that subscribe the same skill. Read by `harness audit --suggest-overrides` to surface skills that have been consistently approved enough times to warrant a `policy.skills.overrides` entry. **Not encrypted** even when `policy.encryption.enabled: true` (the FileBank doesn't accept a key — see §4.4 for the bank asymmetry).

#### Skills FileBank — managed files (non-`db` collections)

The skills bank also contains `FileBank`-managed files for skill metadata, indexes, and embeddings. These are not `db` collections in the just-bash-data sense — they're plain JSON/binary files written by `agent-skills-cli`'s `FileBank` class. Listed here for completeness; their internal structure is owned by `agent-skills-cli`, not by this harness.

#### Sessions bank — `db sessions`

Session metadata document. **One row per session**, inserted by `harness new` at session creation time. Stores `id`, `createdAt` timestamp, and the `Policy` that was loaded for the session. Read by `harness resume <id>` and `session.load()` to rehydrate the session's policy and creation context. **Encrypted** when `policy.encryption.enabled: true`.

The collection name `sessions` is identical to the parent dir concept. To avoid renderer confusion: `~/.harness/sessions/<sessionId>/` is the **directory layout**; `db sessions` is a **collection inside one such directory** that holds metadata about the session that owns the directory. Dir structure and collection structure happen to share the word "sessions" but are different layers.

#### Sessions bank — `db turns`

Turn-by-turn audit log. **One row per `Turn`**, appended by `session.appendTurn()` once per `runTurn` invocation (per §4 turn protocol). Stores user message, tool calls, tool results (post-redaction per §4.3), assistant text, thinking text, stop reason, and the `approvals[]` array recorded during that turn. The full session history is reconstructed by `db turns find '{}' --sort ts:1`. **Encrypted** when enabled.

#### Sessions bank — `db approvals`

Per-session approval records. Each row is an `ApprovalRecord` containing the `PendingAction` (skill id, derived category, rationale, derivedFrom reasons), the decision (`allow` / `deny`), and the source (`policy` / `user`). Persisted by `approval.record()` after each gate decision. Read by `harness audit <sessionId>` to display the per-session approval history. **Encrypted** when enabled.

Note: `db approvals` is per-session and lives alongside `db turns`. The bank-level `db approval_stats` (skills bank) aggregates counters across these per-session records but does not duplicate the row data — the skills-bank counters are derived increments, the per-session records are the audit truth.

#### Memory bank — `db sources`

Wiki-backed memory records. Each row is a memory entry: user/assistant turn pairs auto-persisted at `end_turn` (kind `turn`), explicit user-supplied facts (kind `fact`), and compaction summaries generated at compaction events (kind `compaction-summary`, since v0.3.0). Indexed by `just-bash-wiki` for semantic search; embeddings stored alongside. Read by `harness recall` / `harness search` for cross-session retrieval, and by `loop.ts` at the start of each `runTurn` for in-context recall (per §4 step 2). **Encrypted** when enabled (memory bank does accept a key).

#### Memory bank — wiki internals

`just-bash-wiki` maintains additional internal structures (page indexes, vec embeddings, etc.) inside `policy.memory.rootDir`. These are not user-facing collections and are not enumerated individually here. Their lifecycle is owned by `just-bash-wiki`, not by this harness.

---

#### When you add a new collection

If a future release adds a new `db <coll>` to any bank:

1. Update §6.3 above with a new heading `#### <Bank> — db <coll>` and a short description (purpose, scope, persistence trigger, who reads it, encryption status).
2. Update §6's tree diagram and the bank table to include the new collection.
3. Update `src/rekey.ts` to add the collection to the appropriate per-bank list (`SESSION_COLLECTIONS`, `MEMORY_COLLECTIONS`, or `SKILLS_COLLECTIONS`) — otherwise `harness rekey` won't migrate it. (See doctrine #4 in `LESSONS.md`.)
4. Update §4.3 trust pipeline if the collection is a write sink for tool output.
5. Update §6.2 isolation invariants if the new collection introduces a cross-bank reference pattern.

That five-step list is the operational equivalent of "every feature commit should grep DESIGN/README/CHANGELOG" (doctrine #6) but specialized to collection additions.

---

## 7. Decisions locked for v0

| # | Decision | Resolution |
|---|---|---|
| D1 | Language | TypeScript, Node ≥ 22 (CLI requirement). |
| D2 | Provider | Anthropic only. Pluggable interface. |
| D3 | Approval UX | TTY default; host can inject custom `ApprovalGate`. |
| D4 | Session storage | `createBankBash` on a separate session dir; one bank per session. |
| D5 | Compaction | Slice + memory recall (v0.1.7); optional rolling LLM summary (v0.3.0). See §4.2. |
| D6 | Skill subscription | Explicit only. `harness skills add <pack@vX>` invokes `runSync`. |
| D7 | Telemetry | `bank.listAudit()` is the audit. OTEL post-v0. |
| D8 | Sandbox abstraction | **None.** `runExec` is the boundary. (Was an explicit layer in v0.1; killed after slice.) |

---

## 8. v0 acceptance criteria

The harness is "v0 done" when:

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `harness new` creates a session with policy + a fresh session-bank dir. | ✅ | smoke run printed session id + dir; `cmdNew` in `src/cli.ts` |
| 2 | `harness chat` runs a single-agent loop using one resolved skill from a real pack. | ✅ | `scratch/e2e-cf-driven.ts` PASS — full loop with real Gemma decisions |
| 3 | A skill that triggers `explicit` prompts on TTY and respects deny. | ✅ | `scratch/e2e.ts` scenarios B and C — explicit user-allow and explicit user-deny |
| 4 | A session can be resumed: history reloaded from `db turns find` + previous approvals visible. | ✅ | `cmdResume` smoke printed session metadata; integration via `e2e.ts` |
| 5 | The harness does not import `just-bash` directly — only via `agent-skills-cli` re-exports or the session bash created by `createBankBash`. | ✅ | grep verified: only `provider-anthropic.ts`/`provider-cloudflare.ts` (not `just-bash`) and `session.ts` (via `createBankBash`) |
| 6 | `bank.listAudit()` shows one entry per executed skill, regardless of approval source. | ✅ | `scratch/slice.ts` step 2 confirmed; `scratch/e2e-cf-driven.ts` shows 1 entry after 1 exec |

---

## 9. Risks

- **`createBankBash` is INTERNAL tier in agent-skills-cli.** Its shape may shift in minor releases. Mitigation: pin CLI to a minor; promote to STABLE before v1.0 of the harness.
- **Compaction unsolved.** v0 will refuse to continue past `maxTurns`. Real solution likely involves `just-bash-wiki`.
- **Approval fatigue.** Default heuristics may over-prompt. Override map is the user's lever; we should track prompt-rate per skill in audit.
- **Spec drift.** `agent-skills` spec is stable but may add fields we want to consume (e.g., explicit `risk` field). Keep `deriveCategory` future-proof by reading defensively.
