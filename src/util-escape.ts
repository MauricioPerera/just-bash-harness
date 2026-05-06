/**
 * Escape a string for safe inclusion within a single-quoted bash string.
 *
 * Used by every module that builds `bash.exec("db ... '<json>'")`-shaped
 * invocations against the `agent-skills-cli` / `just-bash-data` plugins.
 * The transform turns each `'` into `'\''` (close, escape, reopen) which
 * is the canonical bash idiom for embedding single quotes inside a
 * single-quoted string.
 *
 * Centralized here so future hardening (e.g. switching to `printf %q`
 * semantics, rejecting null bytes, handling other shell metacharacters
 * differently) lands in one place instead of four. Prior to this module
 * the same helper was copy-pasted into:
 *
 *   - src/session.ts
 *   - src/memory.ts
 *   - src/approval-stats.ts
 *   - src/rekey.ts
 *
 * Each was identical. See `LESSONS.md` doctrine #4 for the
 * "duplicate facts will desynchronize" lesson that motivated the
 * centralization (issue #10).
 *
 * NOT a general shell escaper. Only safe for inclusion BETWEEN matching
 * single quotes in a bash command. Do not use for argv arrays, do not
 * use for double-quoted contexts.
 */
export const escSingle = (s: string): string => s.replace(/'/g, "'\\''");
