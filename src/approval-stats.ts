// Approval fatigue tracking. Per-skill counters persisted in the skills
// bank (NOT per-session) so the user can spot high-friction skills across
// time and migrate them to `policy.skills.overrides`.
//
// DESIGN §9 acknowledged this as an open risk in v0:
//   "Override map es la palanca; deberíamos trackear prompt-rate por skill
//    en audit"
// — this module closes it.
//
// Storage: `db approval_stats` collection in the skills bank's bash
// instance. The bank already exists for every harness user (it's where
// skills resolve from), so we don't introduce a new directory layout.
//
// Failure mode: increments are best-effort. If the stats write fails, the
// approval flow itself MUST NOT fail — same shape as memory persistence
// in loop.ts. We log diagnostics through an optional onError handler.

import { createBankBash } from "@rckflr/agent-skills-cli";
import type { ApprovalDecision, SkillId } from "./types.js";

type BashInstance = ReturnType<typeof createBankBash>;

const COLLECTION = "approval_stats";

import { escSingle } from "./util-escape.js";

/** Per-skill counters as persisted. `last_decision` lets the suggester
 *  reset eligibility when a skill that was previously always-allowed
 *  starts getting denied — single deny invalidates the suggestion. */
export interface ApprovalStat {
  skillId: SkillId;
  ask_count: number;
  allow_count: number;
  deny_count: number;
  last_ts: string;
  last_decision: ApprovalDecision;
}

export interface ApprovalStatsStore {
  /** Increment counters for a skill. Best-effort — failures swallowed but reported via onError. */
  record(
    skillId: SkillId,
    decision: "allow" | "deny",
    /** Was this decision sourced from the user (TTY ask) or policy/matrix? */
    askedUser: boolean,
  ): Promise<void>;
  /** Read all stats. Used by `harness audit --suggest-overrides`. */
  list(): Promise<ApprovalStat[]>;
}

export interface ApprovalStatsStoreOpts {
  /** Bank root dir — same as skills bank. */
  bankRoot: string;
  encryptionKey?: string;
  encryptionSalt?: string;
  /** Diagnostic sink for non-fatal failures. */
  onError?: (err: Error) => void;
}

export const createApprovalStatsStore = (
  opts: ApprovalStatsStoreOpts,
): ApprovalStatsStore => {
  // One bash instance, reused across calls. createBankBash is idempotent
  // re: dir creation.
  const bash: BashInstance = createBankBash({
    bankDir: opts.bankRoot,
    ...(opts.encryptionKey !== undefined ? { encryptionKey: opts.encryptionKey } : {}),
    ...(opts.encryptionSalt !== undefined ? { salt: opts.encryptionSalt } : {}),
  });

  const reportError = (err: unknown): void => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  const findOne = async (skillId: SkillId): Promise<ApprovalStat | null> => {
    const filter = JSON.stringify({ skillId });
    const res = await bash.exec(`db ${COLLECTION} find '${escSingle(filter)}'`);
    if (res.exitCode !== 0) return null;
    const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ApprovalStat;
        if (parsed.skillId === skillId) return parsed;
      } catch {
        // Skip malformed lines (db output may include status banners).
        continue;
      }
    }
    return null;
  };

  return {
    async record(skillId, decision, askedUser) {
      try {
        const existing = await findOne(skillId);
        const next: ApprovalStat = {
          skillId,
          ask_count: (existing?.ask_count ?? 0) + (askedUser ? 1 : 0),
          allow_count: (existing?.allow_count ?? 0) + (decision === "allow" ? 1 : 0),
          deny_count: (existing?.deny_count ?? 0) + (decision === "deny" ? 1 : 0),
          last_ts: new Date().toISOString(),
          last_decision: decision,
        };
        // db has no upsert; remove + insert keeps the doc unique by skillId.
        const filter = JSON.stringify({ skillId });
        await bash.exec(`db ${COLLECTION} remove '${escSingle(filter)}'`);
        const insertRes = await bash.exec(
          `db ${COLLECTION} insert '${escSingle(JSON.stringify(next))}'`,
        );
        if (insertRes.exitCode !== 0) {
          reportError(new Error(`approval-stats insert exit=${insertRes.exitCode}: ${insertRes.stderr}`));
        }
      } catch (err) {
        reportError(err);
      }
    },

    async list() {
      try {
        const res = await bash.exec(`db ${COLLECTION} find '{}'`);
        if (res.exitCode !== 0) return [];
        const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        const out: ApprovalStat[] = [];
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as ApprovalStat;
            if (parsed.skillId && typeof parsed.ask_count === "number") {
              out.push(parsed);
            }
          } catch {
            continue;
          }
        }
        return out;
      } catch (err) {
        reportError(err);
        return [];
      }
    },
  };
};

// ─── suggester ─────────────────────────────────────────────────────────────

/**
 * Skills matching any of these patterns are NEVER suggested for promotion to
 * `regular`, regardless of how often the user approves them. ROADMAP §2 hard
 * rule: destructive ops keep the human-in-the-loop guarantee.
 *
 * Patterns anchor at start-of-string OR after a `/` or `-` so they fire on
 * fully-qualified skill IDs like `github.com/foo/pack/delete-workflow`
 * without false-matching across word boundaries (e.g. `undelete-cache` does
 * NOT match because `delete-` is preceded by a letter, not a separator).
 *
 * Phase 1 (Option 1) decision recorded 2026-05-06 in
 * `CONTRACT-suggester-blacklist.md`. Phase 2 will add an explicit
 * `destructive: true` frontmatter field; this pattern set remains as the
 * fallback for skills without that field. See DESIGN §3.3 for the rule and
 * the user-visible pattern list.
 */
export const DESTRUCTIVE_SKILL_PATTERNS: readonly RegExp[] = [
  /(^|[/-])delete-/i,
  /(^|[/-])drop-/i,
  /(^|[/-])rm-/i,
  /(^|[/-])force-/i,
  /(^|[/-])nuke-/i,
  /(^|[/-])purge-/i,
  /(^|[/-])truncate-/i,
  /(^|[/-])wipe-/i,
  /(^|[/-])destroy-/i,
  /(^|[/-])prune-/i,
  /(^|[/-])batch-deactivate$/i,
];

/** Returns the first pattern that matches the skillId, or null if none. */
export const matchDestructivePattern = (skillId: SkillId): RegExp | null => {
  for (const re of DESTRUCTIVE_SKILL_PATTERNS) {
    if (re.test(skillId)) return re;
  }
  return null;
};

export interface SuggestOverridesOpts {
  /** Minimum total asks before a skill is eligible for suggestion. */
  minAsks?: number;
  /** Minimum allow_count / ask_count ratio to consider auto-allowing. */
  minAllowRatio?: number;
}

export interface OverrideSuggestion {
  skillId: SkillId;
  ask_count: number;
  allow_count: number;
  deny_count: number;
  /** Computed allow_count / ask_count. */
  ratio: number;
  /** Suggested category — currently always "regular" (auto-allow) since we
   *  only suggest when user has consistently approved. */
  suggested: "regular";
}

/** A skill that would have been suggested but was filtered by a hard rule
 *  (currently: destructive-pattern blacklist). Surfaced so the user can see
 *  WHY a frequently-approved skill never gets promoted. */
export interface SkippedSuggestion {
  skillId: SkillId;
  ask_count: number;
  allow_count: number;
  deny_count: number;
  ratio: number;
  reason: "destructive";
  /** Source of the matched pattern, for user-facing attribution. */
  matchedPattern: string;
}

export interface SuggestOverridesResult {
  suggestions: OverrideSuggestion[];
  /** Skills that passed the ratio/asks gates but were excluded by the
   *  destructive-pattern blacklist. Empty in the common case. */
  skipped: SkippedSuggestion[];
}

/**
 * Pure function over loaded stats. Filters skills with high
 * (askedUser → allow) ratios and zero recent denies. Single deny resets:
 * if last_decision was "deny", the skill is excluded regardless of
 * historical ratio — the user has signaled this skill is not blanket-safe.
 *
 * Skills matching `DESTRUCTIVE_SKILL_PATTERNS` are NEVER suggested for
 * promotion regardless of allow-ratio. They appear in `result.skipped`
 * with the matching pattern attribution so the user understands why.
 */
export const suggestOverrides = (
  stats: readonly ApprovalStat[],
  opts: SuggestOverridesOpts = {},
): SuggestOverridesResult => {
  const minAsks = opts.minAsks ?? 5;
  const minRatio = opts.minAllowRatio ?? 0.95;
  const suggestions: OverrideSuggestion[] = [];
  const skipped: SkippedSuggestion[] = [];
  for (const s of stats) {
    if (s.last_decision === "deny") continue;
    if (s.ask_count < minAsks) continue;
    if (s.deny_count > 0) continue; // any historical deny disqualifies for now
    const ratio = s.ask_count === 0 ? 0 : s.allow_count / s.ask_count;
    if (ratio < minRatio) continue;
    const destructiveMatch = matchDestructivePattern(s.skillId);
    if (destructiveMatch !== null) {
      skipped.push({
        skillId: s.skillId,
        ask_count: s.ask_count,
        allow_count: s.allow_count,
        deny_count: s.deny_count,
        ratio,
        reason: "destructive",
        matchedPattern: destructiveMatch.source,
      });
      continue;
    }
    suggestions.push({
      skillId: s.skillId,
      ask_count: s.ask_count,
      allow_count: s.allow_count,
      deny_count: s.deny_count,
      ratio,
      suggested: "regular",
    });
  }
  // Stable ordering: most-asked first, in both lists.
  suggestions.sort((a, b) => b.ask_count - a.ask_count);
  skipped.sort((a, b) => b.ask_count - a.ask_count);
  return { suggestions, skipped };
};

/** Render a paste-ready YAML snippet for the policy's `skills.overrides`. */
export const renderSuggestionsYaml = (
  suggestions: readonly OverrideSuggestion[],
): string => {
  if (suggestions.length === 0) {
    return "# (no suggestions yet — keep using the harness)\n";
  }
  const lines: string[] = [
    "skills:",
    "  overrides:",
  ];
  for (const s of suggestions) {
    lines.push(
      `    "${s.skillId}": ${s.suggested}    # asks=${s.ask_count} allow=${s.allow_count} deny=${s.deny_count} ratio=${s.ratio.toFixed(2)}`,
    );
  }
  return lines.join("\n") + "\n";
};

/** Render the "skipped because destructive" section. Empty string when
 *  there are no skipped skills, so callers can concatenate unconditionally. */
export const renderSkippedSection = (
  skipped: readonly SkippedSuggestion[],
): string => {
  if (skipped.length === 0) return "";
  const lines: string[] = [
    "",
    `# skipped: ${skipped.length} skill(s) excluded as destructive (hard rule, never auto-promoted)`,
  ];
  for (const s of skipped) {
    lines.push(
      `#   ${s.skillId}    # asks=${s.ask_count} allow=${s.allow_count} ratio=${s.ratio.toFixed(2)} pattern=/${s.matchedPattern}/`,
    );
  }
  return lines.join("\n") + "\n";
};
