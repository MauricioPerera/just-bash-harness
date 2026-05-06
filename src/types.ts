// Public type contracts for the harness. Match DESIGN.md §3.
// No implementation logic lives here.

import type {
  IndexedSkill,
  AuditEntry,
  ChainStep,
} from "@rckflr/agent-skills-cli";

// ─── identifiers ────────────────────────────────────────────────────────────

export type SessionId = string & { readonly __brand: "SessionId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type SkillId = string;          // matches CLI skill identity
export type SnapshotRef = string & { readonly __brand: "SnapshotRef" };

// ─── toolbox (skills) ───────────────────────────────────────────────────────

export interface SkillSummary {
  id: SkillId;                 // full identity per spec §1
  shortId: string;             // `id` from frontmatter
  title: string;
  description: string;
  use_when: string;
  pack: string;                // `<host>/<owner>/<repo>` source
  version: string;
  signatureStatus: "valid" | "unsigned" | "invalid" | "unverified";
  network: readonly string[];          // declared per-skill (spec §2.10)
  filesystem: readonly string[];       // declared per-skill (spec §2.11)
  idempotent: boolean;
  /** The skill's `args` map per spec §2.6. Needed by the LLM to emit
   *  well-typed tool calls, so it lives on the summary not just resolved. */
  args: Record<string, unknown>;
  /** Skills declared by this skill to run automatically after it succeeds
   *  (spec §2.8). Chain executes atomically from the LLM's view — one
   *  approval, one ToolResult. Empty / undefined = no chain. */
  chains?: readonly ChainStep[];
}

/** A skill that has passed validation and is ready to execute.
 *  We don't re-pack the full IndexedSkill — `runExec` looks the skill up
 *  in the bank by `id` (the full identity). */
export interface ResolvedSkill extends SkillSummary {
  similarity?: number;          // when resolved by intent
}

export interface ResolveOpts {
  topK?: number;
  threshold?: number;
}

export interface ToolResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  elapsedMs: number;
  timedOut: boolean;
  /**
   * Number of secret patterns scrubbed from stdout/stderr by `scrubToolResult`
   * before this result was persisted / fed back to the provider. Optional
   * because legacy callers and pre-redact code paths don't set it; a missing
   * value should be treated as "not scrubbed" (NOT "zero matches"). When
   * present, the breakdown by pattern kind lives only in the in-process
   * ScrubResult — the audit trail keeps the count, not the kinds.
   *
   * History: removed as `redacted: boolean` in v0.2.4 (always false because
   * scrubbing wasn't implemented). Restored as `redacted?: number` in v0.3.0
   * when actual scrubbing landed via src/redact.ts.
   */
  redacted?: number;
}

export interface Toolbox {
  list(): Promise<SkillSummary[]>;
  resolve(intent: string, opts?: ResolveOpts): Promise<ResolvedSkill[]>;
  execute(
    skill: ResolvedSkill,
    args: Record<string, unknown>,
    intent?: string,
  ): Promise<ToolResult>;
  /** Read recent audit entries (already includes harness-driven exec records). */
  audit(opts?: { limit?: number }): Promise<AuditEntry[]>;
}

// Re-export for callers — saves them an import of agent-skills-cli for raw types.
export type { AuditEntry, IndexedSkill, ChainStep };

// ─── provider (LLM) ─────────────────────────────────────────────────────────

export interface TurnInput {
  systemPrompt: string;
  history: readonly Turn[];
  user?: string;
  toolResults?: readonly ToolCallResult[];
  availableTools: readonly SkillSummary[];
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "cancelled"
  | "error";

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; skill: SkillId; args: unknown }
  | { type: "stop"; reason: StopReason };

export interface Provider {
  /**
   * Drive one provider round. The optional AbortSignal lets the loop
   * cancel the in-flight LLM request — e.g. on Ctrl+C — without waiting
   * for the stream to drain on its own. Implementations SHOULD pass it
   * to their underlying fetch / SDK so cancellation is real, not just
   * cooperative-at-event-boundary.
   */
  turn(input: TurnInput, signal?: AbortSignal): AsyncIterable<TurnEvent>;
}

// ─── approval ───────────────────────────────────────────────────────────────

export type ApprovalCategory = "prohibited" | "explicit" | "regular";

export interface PendingAction {
  skillId: SkillId;
  category: ApprovalCategory;
  args: Record<string, unknown>;
  /** LLM-supplied reason — UNTRUSTED. Shown verbatim, not interpreted. */
  rationale: string;
  /** Reasons the harness derived this category. Useful for UI / audit. */
  derivedFrom: readonly string[];
}

export type ApprovalDecision = "allow" | "deny" | "ask";

export interface ApprovalRecord {
  ts: string;
  action: PendingAction;
  decision: "allow" | "deny";
  source: "policy" | "user";
}

export interface ApprovalGate {
  check(action: PendingAction): Promise<ApprovalDecision>;
  record(record: ApprovalRecord): Promise<void>;
}

// ─── session ────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  skillId: SkillId;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  callId: string;
  result: ToolResult;
}

export interface Turn {
  id: TurnId;
  ts: string;
  input: {
    user?: string;
    toolResults?: ToolCallResult[];
  };
  output: {
    text: string;
    toolCalls: ToolCall[];
    thinking?: string;
    stopReason: StopReason;
  };
  approvals: ApprovalRecord[];
}

export interface SessionOpts {
  policyPath: string;
  /** Where to put the session bank dir. Required. */
  sessionRoot: string;
}

export interface Session {
  id: SessionId;
  createdAt: string;
  policy: Policy;
  turns: Turn[];
}

export interface SessionStore {
  create(opts: SessionOpts): Promise<SessionId>;
  load(id: SessionId): Promise<Session>;
  appendTurn(id: SessionId, turn: Turn): Promise<void>;
  snapshot(id: SessionId): Promise<SnapshotRef>;
  resume(id: SessionId): Promise<Session>;
  /**
   * Evict cached `Bash` instances. Without an arg, evicts ALL cached
   * sessions; with a `SessionId`, evicts only that session's bash.
   *
   * For one-shot CLI flows this is a no-op (process exits and OS
   * reclaims). For long-running REPLs or daemon-style hosts that
   * touch many sessions over time, calling `dispose()` on idle
   * sessions or on REPL exit prevents accumulation. Each cached
   * `Bash` is a child-process + file-handles holder via
   * `createBankBash` → `just-bash`, so unbounded retention is the
   * lifetime risk this method addresses.
   *
   * Idempotent. Calling on a non-existent id or on an empty cache
   * is a no-op. Returns the count of bashes evicted.
   */
  dispose(id?: SessionId): number;
}

// ─── policy ─────────────────────────────────────────────────────────────────

export interface Policy {
  version: 1;
  skills: {
    subscribed: ReadonlyArray<{ pack: string; version: string }>;
    /** skill id → forced category. Escape hatch for derivation heuristics. */
    overrides: Readonly<Record<string, ApprovalCategory>>;
  };
  signature: {
    /** If true, unsigned skills resolve as `prohibited`. */
    require_signed: boolean;
  };
  approval: {
    matrix: Readonly<Record<ApprovalCategory, ApprovalDecision>>;
  };
  limits: {
    maxTurns: number;
    maxToolCallsPerTurn: number;
    maxWallclockMs: number;
  };
  paths: {
    /** Bank dir for skills. Defaults to agent-skills-cli's defaultBankRoot(). */
    skillsBankDir?: string;
    /** Where session sub-dirs are created. */
    sessionsRoot: string;
    auditLogPath?: string;     // optional override; default uses bank's audit
  };
  /**
   * AES-256-GCM at rest for session storage + memory bank. The key itself
   * is read from the `HARNESS_ENCRYPTION_KEY` env var (NEVER stored in
   * policy or on disk). When `enabled: true` and the env var is missing,
   * the harness throws at construction time with a clear message.
   *
   * NOTE: Encryption is a one-time decision per bank dir. Changing the
   * key (or salt) on an existing bank effectively re-keys it — existing
   * data becomes unreadable. Pick a key once per scope and back it up.
   */
  encryption: {
    enabled: boolean;
    /** Optional salt namespacing. just-bash-data uses defaults if absent. */
    saltMemory?: string;
    saltSession?: string;
  };
  /** Memory layer (just-bash-wiki backed). Opt-in. */
  memory: {
    /** Master switch. When false, no memory dep is constructed. */
    enabled: boolean;
    /** Wiki bank dir. Each scope (per-user / per-project) gets its own. */
    rootDir: string;
    recall: {
      /** Top-K hits before charBudget filter. */
      topK: number;
      /** Approximate char cap across recalled snippets injected into prompt. */
      charBudget: number;
    };
    persist: {
      /** Persist user msg + final assistant text after each end_turn. */
      autoPersistTurns: boolean;
      /** Skip turns where the assistant text is shorter than this many chars. */
      minMessageLength: number;
    };
    /**
     * Compaction: cap the active message history sent to the provider.
     * Older turns stay in `db turns` (full session audit) AND in memory
     * (auto-persisted), so they're still searchable via recall, just not
     * verbatim in the LLM context.
     *
     * Requires `enabled: true` AND `persist.autoPersistTurns: true` —
     * otherwise compacting drops information that has nowhere to live.
     */
    compaction: {
      enabled: boolean;
      /** Active history is the last `windowSize` turns. >= 1. */
      windowSize: number;
      /**
       * Optional rolling summary. When enabled, on each turn where
       * compaction drops history the harness asks the active provider
       * for a structured summary of the dropped turns, prepends it to
       * subsequent system prompts, and persists it to memory as a
       * `compaction-summary` kind record.
       *
       * Cost: every triggered compaction does one extra provider call
       * with the dropped turns as input + at most `maxTokens` of output.
       * For long sessions the cost is the user's responsibility — opt-in.
       *
       * Default disabled — the slice + memory recall path from v0.1.7
       * is preserved when summarize.enabled is false.
       */
      summarize?: {
        enabled: boolean;
        /** Cap on the summary call's output. */
        maxTokens: number;
      };
    };
  };
}
