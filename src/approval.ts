// Approval gate. The category is DERIVED from existing skill metadata —
// no new spec field. See DESIGN §3.3 / §5.

import type {
  ApprovalCategory,
  ApprovalDecision,
  ApprovalGate,
  ApprovalRecord,
  PendingAction,
  Policy,
  ResolvedSkill,
} from "./types.js";

// ─── derivation ─────────────────────────────────────────────────────────────

export interface DerivedCategory {
  category: ApprovalCategory;
  /** Human-readable reasons. Recorded with the action; visible to user. */
  derivedFrom: string[];
}

/**
 * Map a resolved skill + optional chain skills + policy → category.
 *
 * When `chainSkills` is non-empty (the parent declared chains[]), the
 * effective category is the WORST (most restrictive) over the parent
 * plus every chain step. This closes the human-approval bypass that
 * would otherwise let a benign-looking parent execute privileged chain
 * steps without the user seeing them at the approval gate.
 *
 * Precedence:
 *   1. Override map by parent id/shortId (highest — escape hatch).
 *   2. Signature gate over parent + any chain step (any unsigned →
 *      prohibited when require_signed).
 *   3. Capability heuristics: union of network/filesystem flags + any
 *      non-idempotent step → explicit.
 *   4. Default → regular.
 *
 * `derivedFrom` reasons attribute escalations to specific chain steps
 * so the approval prompt can show what's being approved.
 */
export const deriveCategory = (
  skill: ResolvedSkill,
  policy: Policy,
  chainSkills: readonly ResolvedSkill[] = [],
): DerivedCategory => {
  const reasons: string[] = [];

  // 1. Override map (highest priority).
  const overrides = policy.skills.overrides;
  const override = overrides[skill.id] ?? overrides[skill.shortId];
  if (override) {
    reasons.push(`override:${override}`);
    return { category: override, derivedFrom: reasons };
  }

  // The set of skills whose capabilities count: parent + every chain step.
  const allSkills: readonly ResolvedSkill[] = [skill, ...chainSkills];

  // 2. Signature gate (any unsigned in the pipeline → prohibited).
  if (policy.signature.require_signed) {
    for (const s of allSkills) {
      if (s.signatureStatus !== "valid") {
        const tag = s === skill ? "" : `chain:${s.shortId} `;
        reasons.push(`${tag}signature:${s.signatureStatus}`);
        return { category: "prohibited", derivedFrom: reasons };
      }
    }
  }

  // 3. Capability heuristics — escalate to explicit if any step has any.
  for (const s of allSkills) {
    const tag = s === skill ? "" : `chain:${s.shortId} `;
    if (s.network.length > 0) {
      reasons.push(`${tag}network:${s.network.length}`);
    }
    if (s.filesystem.length > 0) {
      reasons.push(`${tag}filesystem:${s.filesystem.length}`);
    }
    if (!s.idempotent) {
      reasons.push(`${tag}non-idempotent`);
    }
  }

  if (reasons.length > 0) {
    return { category: "explicit", derivedFrom: reasons };
  }

  // 4. Default.
  reasons.push("default");
  return { category: "regular", derivedFrom: reasons };
};

// ─── gate ───────────────────────────────────────────────────────────────────

export interface ApprovalGateOpts {
  policy: Policy;
  audit: (record: ApprovalRecord) => Promise<void>;
}

export const createApprovalGate = (opts: ApprovalGateOpts): ApprovalGate => {
  const matrix = opts.policy.approval.matrix;

  return {
    async check(action: PendingAction): Promise<ApprovalDecision> {
      // Hard-deny prohibited regardless of matrix configuration.
      if (action.category === "prohibited") return "deny";
      return matrix[action.category] ?? "ask";
    },

    async record(record: ApprovalRecord): Promise<void> {
      await opts.audit(record);
    },
  };
};

// ─── TTY prompt helper ──────────────────────────────────────────────────────

/**
 * Render an approval prompt to the user via stdin/stdout.
 * The loop calls this when `check()` returns 'ask'.
 *
 * Defaults to 'deny' on EOF / non-TTY / signal — fail closed.
 */
export const promptUserApproval = async (
  action: PendingAction,
): Promise<"allow" | "deny"> => {
  const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!isTTY) return "deny";

  const lines = [
    "",
    "─── approval requested ───────────────────────────────────────",
    `  skill:    ${action.skillId}`,
    `  category: ${action.category}`,
    `  derived:  ${action.derivedFrom.join(", ")}`,
    `  args:     ${JSON.stringify(action.args)}`,
    `  rationale (LLM, untrusted):`,
    ...action.rationale.split("\n").map((l) => `    ${l}`),
    "──────────────────────────────────────────────────────────────",
    "  Allow this action? [y/N]: ",
  ];
  process.stdout.write(lines.join("\n"));

  return new Promise<"allow" | "deny">((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const answer = buf.slice(0, i).trim().toLowerCase();
      cleanup();
      resolve(answer === "y" || answer === "yes" ? "allow" : "deny");
    };
    const onEnd = (): void => {
      cleanup();
      resolve("deny");
    };
    const cleanup = (): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onEnd);
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onEnd);
  });
};
