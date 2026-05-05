// Per-invocation policy overrides driven by CLI flags. Kept in its own
// module so it can be unit-tested without spinning up cli.ts (which has
// a top-level main() that runs on import).
//
// Flags currently handled:
//   --allow-unsigned  drop signature.require_signed for this invocation
//                     (development-only escape hatch; documented in HELP
//                     and the deny error message in loop.ts).

import type { Policy } from "./types.js";

export interface ApplyOverridesOpts {
  /** Sink for the user-visible warning when a flag overrides policy. */
  warn?: (line: string) => void;
}

export const applyPolicyOverrides = (
  policy: Policy,
  flags: Map<string, string | true>,
  opts: ApplyOverridesOpts = {},
): Policy => {
  if (flags.get("allow-unsigned") === true && policy.signature.require_signed) {
    opts.warn?.(
      "  (--allow-unsigned set: unsigned skills will fall through to capability checks instead of being prohibited. Use only for local development.)\n",
    );
    return {
      ...policy,
      signature: { ...policy.signature, require_signed: false },
    };
  }
  return policy;
};
