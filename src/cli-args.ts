// Tiny argv parser used by the CLI. Extracted for testability.
//
// Conventions:
//   - Tokens NOT starting with `--` are positional.
//   - `--flag=value` parses to `{ flag: "value" }`.
//   - `--flag value` parses to `{ flag: "value" }` (consumes next token if it
//     does not itself start with `--`).
//   - `--flag` (no following value or followed by another `--flag`) parses to
//     `{ flag: true }`.
//   - Argument order is preserved in `positional`.

export interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

export const parseArgs = (argv: readonly string[]): Args => {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
};
