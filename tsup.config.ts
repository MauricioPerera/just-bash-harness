import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points:
  //   - cli.ts   → executable shipped via package.json `bin`
  //   - index.ts → programmatic API for embedding the harness
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // We don't bundle node_modules — the user installs them at consume time.
  // This keeps the dist tiny and makes the dependency graph explicit.
  external: [
    "@anthropic-ai/sdk",
    "@rckflr/agent-skills-cli",
    // just-bash and just-bash-data come in transitively via agent-skills-cli
    // — listing them as externals keeps the bundler hands-off if anyone
    // accidentally imports them directly during dev.
    "just-bash",
    "just-bash-data",
    // just-bash-wiki is imported directly from src/memory.ts. tsup would
    // treat it as external by default (it's in `dependencies`), but we list
    // it explicitly here for symmetry with the others — see issue #12.
    "just-bash-wiki",
    "yaml",
  ],
  dts: true,
  sourcemap: true,
  clean: true,
  // Preserves `#!/usr/bin/env node` at the top of cli.ts so the bin works
  // out of the box on Linux/macOS once npm sets the executable bit.
  shims: false,
  banner: {
    // tsup emits .js; Node treats it as ESM (we declare type: module).
    // Nothing to add here — keep clean.
  },
});
