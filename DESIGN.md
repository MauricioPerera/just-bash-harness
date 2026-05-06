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

Category is derived, not declared. The four precedence rules, **in order** (the first that matches returns and short-circuits the rest):

1. **Override (highest priority — escape hatch).** If `policy.skills.overrides[skill.id]` or `policy.skills.overrides[skill.shortId]` is set, return that category and stop. The override can map to `regular`, `explicit`, OR `prohibited` — it's not "auto-allow", it's "user has explicitly chosen the category for this skill, replacing the heuristics". This is checked FIRST so that a user who has audited a skill can fully short-circuit derivation; it is NOT a feedback loop or a post-hoc bypass.

2. **Signature gate over the union.** If `policy.signature.require_signed: true`, scan the union `[skill, ...chainSkills]`. If ANY one has `signatureStatus !== "valid"` (i.e. `unsigned`, `invalid`, OR `unverified` — three failure states, not just "invalid signature"), return `prohibited`. The reason record names which skill in the chain triggered (e.g. `chain:foo signature:unsigned`).

3. **Capability heuristics over the union.** Collect reasons across `[skill, ...chainSkills]`:
   - `network.length > 0` → escalate to `explicit`
   - `filesystem.length > 0` → escalate to `explicit`
   - `idempotent === false` → escalate to `explicit`

   If any reasons collected, return `explicit` with all reasons attributed (`network:N` for the parent, `chain:foo network:N` for chain steps).

4. **Default: `regular`.**

The harness uses inputs that all come from existing spec fields — no new fields required:

| Signal | Effect on category |
|---|---|
| `policy.skills.overrides[id]` or `[shortId]` is set | the override value wins (any of `regular | explicit | prohibited`) |
| Any skill in `[parent, ...chains]` has `signatureStatus !== "valid"` AND `policy.signature.require_signed: true` | `prohibited` |
| Any skill in `[parent, ...chains]` has `network[]` non-empty | escalate to `explicit` |
| Any skill in `[parent, ...chains]` has `filesystem[]` non-empty | escalate to `explicit` |
| Any skill in `[parent, ...chains]` has `idempotent === false` | escalate to `explicit` |
| else | `regular` |

#### Chain step union (v0.2.3 — security fix)

Pre-v0.2.3, `deriveCategory` evaluated only the parent's metadata. A parent skill that declared `chains[]` could silently smuggle privileged steps past the human approval prompt: a benign-looking parent (signed, idempotent, no network → category `regular` → auto-allow) declares a chain step pointing at a skill with `network: ["evil.com"]`, the user sees no prompt, the network call goes through. The runtime sandbox per-step still applied — but the human-in-the-loop gate was bypassed.

Since v0.2.3, the union over parent + every chain step closes that hole. The `derivedFrom` array tags chain-attributed reasons with `chain:<short-id>` so the approval prompt shows where each capability came from. See `LESSONS.md` doctrine #1.

#### Unknown chain step → synthetic worst-case

A `chains[]` entry whose `skill` identity is NOT resolvable in the bank (typo, missing dependency, malicious crafted reference) is synthesized by `loop.ts` as a worst-case ResolvedSkill before being passed to `deriveCategory`:

```ts
{ ...parent, id: stepId, signatureStatus: "unsigned",
  network: ["*"], filesystem: ["*"], idempotent: false }
```

The union then forces `prohibited` regardless of policy permissiveness. This is a **defense-in-depth** layer — even if a user disables `require_signed` (e.g. via `--allow-unsigned` for development), the synthetic step's worst-case capabilities still escalate the category. Verified by the `unknown chain step still escalates when signature gate is off` test in `approval.test.ts`.

Override map is the escape hatch for bad heuristics — not the model. Categories the model claims are ignored; only categories the harness derives (or the user's override map dictates) reach the gate.

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

The harness operates on **two separate root dirs**:

```
$XDG_CONFIG_HOME/agent-skills/        skills FileBank (existing convention)
$HARNESS_SESSIONS/<session-id>/       per-session bash bank dir
```

Inside each session dir, the session bash instance keeps `db sessions`, `db turns`, `db approvals` collections. `runExec` per-skill scratch directories are ephemeral; the harness does not see them.

There is no in-memory `MountableFs` to design — the CLI handles it per skill.

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
