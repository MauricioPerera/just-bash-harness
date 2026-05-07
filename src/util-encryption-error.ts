// Detect AES-GCM key-mismatch errors raised by `just-bash-data` when an
// encrypted bank is opened with the wrong `HARNESS_ENCRYPTION_KEY`, and
// wrap them with an actionable message that names the env var.
//
// Why this exists: pre-wrapping, the failure surface was a raw
//   `db <collection> find: exit code 3
//    Error: Unsupported state or unable to authenticate data`
// — accurate but cryptic. Users who hit this assumed the bank was corrupt
// and filed bug reports. The wrapper converts a "user thinks data is
// corrupt" bug into a "user fixes an env var" non-bug.
//
// Closes ROADMAP §4 P1a #1 (residual deuda from harness issue #16). The
// documentation side of #16 (DESIGN §4.4 explaining the failure mode) has
// already shipped; this is the implementation side.
//
// Doctrine: bias the heuristic toward FALSE NEGATIVES, never false
// positives. Failing to wrap a real key mismatch costs the user clarity
// but doesn't break anything; wrapping a non-encryption error with the
// encryption hint is more harmful (it sends them down the wrong fix
// path). The patterns below match only AES-GCM-specific phrases.

/** Returns true iff the error shape matches a known AES-GCM key-mismatch
 *  signature. Inspects both `.message` and `.stderr` (if present), since
 *  `just-bash-data` propagates errors via Bash exec results that may
 *  carry the cryptographic detail in stderr rather than the JS Error
 *  message. */
export const detectEncryptionError = (err: unknown): boolean => {
  if (err === null || err === undefined) return false;
  const text = extractErrorText(err);
  if (text.length === 0) return false;

  // Phrase A: Node crypto's GCM authentication failure surface.
  // Observed verbatim from `just-bash-data` when the key is wrong:
  //   "Unsupported state or unable to authenticate data"
  if (/unable to authenticate data/i.test(text)) return true;

  // Phrase B: explicit "authentication tag" mention. AES-GCM uses an
  // authentication tag for integrity; a wrong key produces a tag
  // mismatch. Library-agnostic phrase, occasionally appears.
  if (/authentication tag/i.test(text)) return true;

  // Phrase C: legacy OpenSSL surface, "bad decrypt".
  if (/bad decrypt/i.test(text)) return true;

  // Phrase D: combined heuristic — "decrypt" mention AND a non-zero exit
  // code shape. Catches future error-text drifts in `just-bash-data`
  // without matching unrelated errors (a `decrypt` mention WITHOUT an
  // exit-code signal is too weak to wrap).
  if (/decrypt/i.test(text) && /exit\s*(?:code)?\s*[=:]?\s*[1-9]/i.test(text)) {
    return true;
  }

  return false;
};

/** Extract searchable text from an unknown thrown value. Pulls from
 *  Error.message + Error.stderr (custom field used by some thrown
 *  shapes from bash exec) + Error.cause chain. Keeps non-Error values
 *  via String(). */
const extractErrorText = (err: unknown): string => {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") parts.push(stderr);
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== err) {
      parts.push(extractErrorText(cause));
    }
  } else if (typeof err === "string") {
    parts.push(err);
  } else if (typeof err === "object") {
    // Best-effort for thrown plain objects (unusual but legal).
    try {
      parts.push(JSON.stringify(err));
    } catch {
      parts.push(String(err));
    }
  } else {
    parts.push(String(err));
  }
  return parts.join("\n");
};

/** Build an actionable Error message from a detected key-mismatch.
 *  `context` is a short label (e.g. "harness audit") prefixing the
 *  message so the user knows which command surfaced the problem.
 *
 *  Constraint: NEVER echoes any portion of the encryption key, even
 *  fragments or hashes — the user's shell history may be shared. */
export const wrapEncryptionError = (err: unknown, context: string): Error => {
  const original =
    err instanceof Error ? err.message : String(err ?? "(no message)");
  // Truncate diagnostics so a multi-line stderr dump doesn't bury the
  // actionable hint at the bottom.
  const truncated =
    original.length > 200 ? `${original.slice(0, 200)}…` : original;

  const lines = [
    `${context}: encrypted bank could not be decrypted with the current HARNESS_ENCRYPTION_KEY.`,
    "",
    "Likely causes:",
    "  - HARNESS_ENCRYPTION_KEY changed since this bank was created.",
    "  - The bank was created with a different key (another shell, another machine, or a different .env).",
    "  - The bank was rekeyed and the env var was not updated to the new value.",
    "",
    "Fixes:",
    "  - To rotate keys intentionally, run `harness rekey --from-env <old-var> --to-env <new-var>` BEFORE changing the env var.",
    "  - If you set the wrong key by accident, restore the previous HARNESS_ENCRYPTION_KEY and retry.",
    "  - If the original key is lost, the data is not recoverable — encryption is a one-way decision (DESIGN §4.4).",
    "",
    `Original error (truncated): ${truncated}`,
  ];
  const wrapped = new Error(lines.join("\n"));
  // Preserve the original error chain for any caller that wants it for
  // debugging. Stack trace is intentionally NOT preserved: the wrapped
  // message is for end-users, not for the bug tracker.
  (wrapped as { cause?: unknown }).cause = err;
  return wrapped;
};
