// Skill resolution + execution. Backed by FileBank + runQuery + runExec
// from @rckflr/agent-skills-cli. Validated end-to-end by scratch/slice.ts.

import {
  FileBank,
  runQuery,
  runExec,
  type EmbeddingProvider,
  type AuditEntry,
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
}

const TIMEOUT_DEFAULT = 60;

/** Pull the harness-relevant fields off an IndexedSkill into a SkillSummary. */
const summarize = (skill: {
  identity: string;
  id: string;
  title: string;
  description: string;
  use_when: string;
  version: string;
  args?: Record<string, unknown>;
  network?: readonly string[];
  filesystem?: readonly string[];
  idempotent?: boolean;
  provenance: { source: string; signature_status?: string };
}): SkillSummary => ({
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
  args: skill.args ?? {},
});

export const createToolbox = (opts: ToolboxOpts): Toolbox => {
  const { bank, embedder } = opts;
  const timeoutSec = opts.execTimeoutSec ?? TIMEOUT_DEFAULT;
  const tenant = opts.tenant;

  return {
    async list(): Promise<SkillSummary[]> {
      const skills = await bank.listSkills();
      return skills.map(summarize);
    },

    async resolve(intent: string, resolveOpts?: ResolveOpts): Promise<ResolvedSkill[]> {
      const result = await runQuery({
        intent,
        bank,
        embedder,
        ...(resolveOpts?.topK !== undefined ? { k: resolveOpts.topK } : {}),
        ...(tenant !== undefined ? { tenant } : {}),
      });

      // Look up full IndexedSkill records to get fields runQuery's hit doesn't carry.
      const all = await bank.listSkills();
      const byId = new Map(all.map((s) => [s.identity, s]));

      const resolved: ResolvedSkill[] = [];
      for (const hit of result.hits) {
        const full = byId.get(hit.identity);
        if (!full) continue;
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
        // runExec doesn't currently emit a redaction flag; leave false until
        // arg-level sensitivity markers land in the spec.
        redacted: false,
      };
    },

    async audit(opts?: { limit?: number }): Promise<AuditEntry[]> {
      return bank.listAudit({ limit: opts?.limit ?? 100 });
    },
  };
};

export type { Toolbox, ResolvedSkill, ResolveOpts, SkillSummary, ToolResult };
