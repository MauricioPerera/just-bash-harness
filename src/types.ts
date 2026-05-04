// Public type contracts for the harness. Match DESIGN.md §3.
// No implementation logic lives here.

import type {
  IndexedSkill,
  AuditEntry,
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
  redacted: boolean;            // sensitive args stripped from audit
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
export type { AuditEntry, IndexedSkill };

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
  turn(input: TurnInput): AsyncIterable<TurnEvent>;
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
}
