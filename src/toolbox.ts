// Skill resolution + execution. Backed by FileBank + runQuery + runExec
// from @rckflr/agent-skills-cli. Validated end-to-end by scratch/slice.ts.

import {
  FileBank,
  runQuery,
  runExec,
  detectHost,
  detectAvailableCommands,
  checkApplicability,
  type EmbeddingProvider,
  type AuditEntry,
  type HostContext,
  type ApplicableWhen,
  type IndexedSkill,
} from "@rckflr/agent-skills-cli";

import type {
  ResolvedSkill,
  ResolveOpts,
  SkillSummary,
  ToolResult,
  Toolbox,
} from "./types.js";

export interface ToolboxOpts {
  bank: FileBank;
  embedder: EmbeddingProvider;
  /** Hard timeout for individual skill execution. Default 60s. */
  execTimeoutSec?: number;
  /** If set, recorded in audit + used for intent-conditional rerank scoping. */
  tenant?: string;
  /**
   * Filter list/resolve output by the skill's `applicable_when` (spec §2.7).
   * Default true. Set false to expose ALL subscribed skills regardless of
   * host fitness — useful for debugging or for hosts where command detection
   * is unreliable.
   */
  filterApplicable?: boolean;
  /**
   * Override the host context. Defaults to `detectHost()` augmented with
   * `detectAvailableCommands(...)` over the union of `required_commands` /
   * `applicable_when.shell_commands_present` declared by subscribed skills.
   * Tests inject a fixed host to exercise the filter deterministically.
   */
  hostContext?: HostContext;
}

const TIMEOUT_DEFAULT = 60;

/** Pull the harness-relevant fields off an IndexedSkill into a SkillSummary. */
const summarize = (skill: IndexedSkill): SkillSummary => ({
  id: skill.identity,
  shortId: skill.id,
  title: skill.title,
  description: skill.description,
  use_when: skill.use_when,
  pack: skill.provenance.source,
  version: skill.version,
  signatureStatus:
    (skill.provenance.signature_status as SkillSummary["signatureStatus"]) ??
    "unsigned",
  network: skill.network ?? [],
  filesystem: skill.filesystem ?? [],
  idempotent: skill.idempotent ?? false,
  args: (skill.args ?? {}) as Record<string, unknown>,
});

/** Collect every shell command name a skill might need from `required_commands`
 *  + `applicable_when.shell_commands_present`. We only probe commands that
 *  appear somewhere in the subscribed set. */
const collectRequiredCommands = (skills: readonly IndexedSkill[]): string[] => {
  const all = new Set<string>();
  for (const s of skills) {
    const rc = (s as { required_commands?: readonly string[] }).required_commands;
    if (rc) for (const c of rc) all.add(c);
    const aw = (s as { applicable_when?: ApplicableWhen }).applicable_when;
    if (aw?.shell_commands_present) {
      for (const c of aw.shell_commands_present) all.add(c);
    }
  }
  return Array.from(all);
};

export const createToolbox = (opts: ToolboxOpts): Toolbox => {
  const { bank, embedder } = opts;
  const timeoutSec = opts.execTimeoutSec ?? TIMEOUT_DEFAULT;
  const tenant = opts.tenant;
  const filterApplicable = opts.filterApplicable !== false;

  // Lazy host context — built on first list/resolve so toolbox creation is
  // free of side effects.
  let cachedHost: HostContext | null = opts.hostContext ?? null;
  const ensureHost = async (): Promise<HostContext> => {
    if (cachedHost !== null) return cachedHost;
    const base = detectHost();
    const skills = await bank.listSkills();
    const cmds = collectRequiredCommands(skills);
    const available = cmds.length > 0
      ? detectAvailableCommands(cmds)
      : new Set<string>();
    cachedHost = { ...base, shellCommandsAvailable: available };
    return cachedHost;
  };

  /** Drop skills whose applicable_when doesn't match the host. Returns the
   *  unchanged input when the filter is disabled. */
  const applyFilter = async (skills: IndexedSkill[]): Promise<IndexedSkill[]> => {
    if (!filterApplicable) return skills;
    const host = await ensureHost();
    return skills.filter((s) => {
      const aw = (s as { applicable_when?: ApplicableWhen }).applicable_when;
      return checkApplicability(aw, host).applicable;
    });
  };

  return {
    async list(): Promise<SkillSummary[]> {
      const all = await bank.listSkills();
      const filtered = await applyFilter(all);
      return filtered.map(summarize);
    },

    async resolve(intent: string, resolveOpts?: ResolveOpts): Promise<ResolvedSkill[]> {
      // runQuery has its own filterApplicable defaulting to true; we let it
      // do the work AND post-filter to honor the harness opt explicitly.
      const result = await runQuery({
        intent,
        bank,
        embedder,
        filterApplicable,
        ...(resolveOpts?.topK !== undefined ? { k: resolveOpts.topK } : {}),
        ...(tenant !== undefined ? { tenant } : {}),
      });

      const all = await bank.listSkills();
      const byId = new Map(all.map((s) => [s.identity, s]));

      const resolved: ResolvedSkill[] = [];
      for (const hit of result.hits) {
        const full = byId.get(hit.identity);
        if (!full) continue;
        // Defensive double-check: if our filter says no, drop even if the
        // CLI returned it. Cheap and defensive.
        if (filterApplicable) {
          const host = await ensureHost();
          const aw = (full as { applicable_when?: ApplicableWhen }).applicable_when;
          if (!checkApplicability(aw, host).applicable) continue;
        }
        resolved.push({
          ...summarize(full),
          similarity: hit.cosine,
        });
      }
      return resolved;
    },

    async execute(
      skill: ResolvedSkill,
      args: Record<string, unknown>,
      intent?: string,
    ): Promise<ToolResult> {
      const result = await runExec({
        bank,
        skillIdentifier: skill.id, // full identity per spec §1
        args,
        timeoutSec,
        ...(intent !== undefined ? { intent } : {}),
        ...(tenant !== undefined ? { tenant } : {}),
      });
      return {
        ok: result.exit_code === 0 && !result.timed_out,
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exit_code,
        elapsedMs: result.elapsed_ms,
        timedOut: result.timed_out,
        redacted: false,
      };
    },

    async audit(opts?: { limit?: number }): Promise<AuditEntry[]> {
      return bank.listAudit({ limit: opts?.limit ?? 100 });
    },
  };
};

export type { Toolbox, ResolvedSkill, ResolveOpts, SkillSummary, ToolResult };
