// Public library surface for embedding the harness.
//
// CLI users invoke via the `harness` binary (see src/cli.ts).
// Library consumers import named exports from this file.
//
// All exports here are STABLE for the v0 line. Breaking changes require
// a major version bump per CHANGELOG.md.

// ── core orchestration ───────────────────────────────────────────────────
export { runTurn } from "./loop.js";
export type { LoopDeps, LoopHandlers, RunOpts } from "./loop.js";

// ── provider factory + named factories ──────────────────────────────────
export {
  createAnthropicProvider,
  createCloudflareProvider,
  resolveProviderFromEnv,
} from "./provider.js";
export type {
  AnthropicProviderOpts,
  CloudflareProviderOpts,
  ResolveProviderOpts,
  Provider,
} from "./provider.js";

// ── toolbox ─────────────────────────────────────────────────────────────
export { createToolbox } from "./toolbox.js";
export type { ToolboxOpts } from "./toolbox.js";

// ── session store ───────────────────────────────────────────────────────
export { createSessionStore, restoreSnapshot } from "./session.js";
export type { SessionStoreOpts } from "./session.js";

// ── approval ────────────────────────────────────────────────────────────
export {
  createApprovalGate,
  deriveCategory,
  promptUserApproval,
} from "./approval.js";
export type { ApprovalGateOpts, DerivedCategory } from "./approval.js";

// ── policy ──────────────────────────────────────────────────────────────
export { loadPolicy, DEFAULT_POLICY } from "./policy.js";

// ── argv parser ─────────────────────────────────────────────────────────
export { parseArgs } from "./cli-args.js";
export type { Args } from "./cli-args.js";

// ── shared types ────────────────────────────────────────────────────────
export type {
  ApprovalCategory,
  ApprovalDecision,
  ApprovalGate,
  ApprovalRecord,
  AuditEntry,
  IndexedSkill,
  PendingAction,
  Policy,
  ResolvedSkill,
  ResolveOpts,
  Session,
  SessionId,
  SessionOpts,
  SessionStore,
  SkillId,
  SkillSummary,
  SnapshotRef,
  StopReason,
  Toolbox,
  ToolCall,
  ToolCallResult,
  ToolResult,
  Turn,
  TurnEvent,
  TurnId,
  TurnInput,
} from "./types.js";
