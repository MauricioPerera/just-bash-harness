// Secret redaction for tool stdout/stderr before it crosses persistence
// or LLM boundaries. Closes the gap left by removing `ToolResult.redacted`
// in v0.2.4 (it was always false because no scrubbing happened).
//
// Phase 1 (this module): conservative regex pass over a small set of
// well-known secret formats. Each match is replaced with a marker
// `[REDACTED:<kind>:<len>]` so the LLM still sees that *something* was
// there — replacing with empty would be more confusing.
//
// Phase 2 (future): policy-driven config (additional patterns,
// per-skill opt-out for skills that legitimately handle secret material).
// Tracked separately in the issue.

export interface RedactionPattern {
  /** Short identifier surfaced in the marker, e.g. "aws-access-key". */
  kind: string;
  /** Regex to match the secret. MUST be /g (global) — we use replaceAll. */
  pattern: RegExp;
}

/**
 * Conservative default patterns. Tuned for low false-positive rate over
 * code/log output the harness's tool skills typically print:
 *
 *  - AWS access key id (literal AKIA prefix + 16 chars)
 *  - GitHub PAT prefixes (ghp_, gho_, ghs_, ghu_, github_pat_)
 *  - Generic Slack token prefixes (xoxb-, xoxp-, xoxa-, xoxr-)
 *  - JWT shape (three base64url segments separated by dots; checks length
 *    floor to avoid trivial 'eyJ...' strings)
 *  - Private-key PEM markers (BEGIN ... PRIVATE KEY)
 *
 * NOT included (false-positive risk too high without policy config):
 *  - Generic high-entropy hex/base64 — would clip UUIDs, hashes, IDs
 *  - "PASSWORD=" / "TOKEN=" env-style assignments — would clip benign
 *    template files / docs
 *
 * Both of those are good Phase 2 candidates with a per-skill opt-out.
 */
export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [
  { kind: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: "github-token", pattern: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/g },
  { kind: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "pem-private-key", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
];

export interface ScrubResult {
  scrubbed: string;
  /** Total number of distinct matches replaced across all patterns. */
  matched: number;
  /** Per-kind counts for diagnostics. */
  byKind: Record<string, number>;
}

/**
 * Apply patterns to a string. Each match is replaced with
 * `[REDACTED:<kind>:<len>]` where len is the original match length.
 *
 * The marker is intentionally readable — operators auditing `db turns`
 * should be able to see what got scrubbed and roughly what shape it had.
 * Length lets callers tell apart e.g. a 40-char token from a long PEM.
 */
export const scrubSecrets = (
  input: string,
  patterns: readonly RedactionPattern[] = DEFAULT_PATTERNS,
): ScrubResult => {
  if (input.length === 0) {
    return { scrubbed: "", matched: 0, byKind: {} };
  }
  let out = input;
  const byKind: Record<string, number> = {};
  let matched = 0;
  for (const p of patterns) {
    out = out.replaceAll(p.pattern, (match) => {
      matched++;
      byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
      return `[REDACTED:${p.kind}:${match.length}]`;
    });
  }
  return { scrubbed: out, matched, byKind };
};

/**
 * Apply scrubbing to a ToolResult-shaped object's stdout/stderr fields.
 * Returns a NEW object — never mutates the input. Callers persist or
 * forward the returned object instead of the original.
 *
 * The returned object has a `redacted: number` field added so the count
 * of matches is preserved through the audit chain. We don't add it to
 * `ToolResult` proper to keep the existing public type contract stable;
 * the field is opt-in for callers that care about the count.
 */
export const scrubToolResult = <T extends { stdout: string; stderr: string }>(
  result: T,
  patterns: readonly RedactionPattern[] = DEFAULT_PATTERNS,
): T & { redacted: number } => {
  const stdoutScrub = scrubSecrets(result.stdout, patterns);
  const stderrScrub = scrubSecrets(result.stderr, patterns);
  return {
    ...result,
    stdout: stdoutScrub.scrubbed,
    stderr: stderrScrub.scrubbed,
    redacted: stdoutScrub.matched + stderrScrub.matched,
  };
};
