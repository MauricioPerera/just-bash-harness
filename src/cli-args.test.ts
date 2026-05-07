import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseArgs } from "./cli-args.js";

test("parseArgs: empty argv", () => {
  const out = parseArgs([]);
  assert.deepEqual(out.positional, []);
  assert.equal(out.flags.size, 0);
});

test("parseArgs: positional only", () => {
  const out = parseArgs(["new", "session-1"]);
  assert.deepEqual(out.positional, ["new", "session-1"]);
  assert.equal(out.flags.size, 0);
});

test("parseArgs: --flag=value", () => {
  const out = parseArgs(["--policy=./p.yaml"]);
  assert.deepEqual(out.positional, []);
  assert.equal(out.flags.get("policy"), "./p.yaml");
});

test("parseArgs: --flag value (space-separated)", () => {
  const out = parseArgs(["--policy", "./p.yaml"]);
  assert.equal(out.flags.get("policy"), "./p.yaml");
  assert.deepEqual(out.positional, []);
});

test("parseArgs: bare --flag at end → true", () => {
  const out = parseArgs(["--debug"]);
  assert.equal(out.flags.get("debug"), true);
});

test("parseArgs: --flag followed by --other → true (no value consumed)", () => {
  const out = parseArgs(["--debug", "--policy", "./p.yaml"]);
  assert.equal(out.flags.get("debug"), true);
  assert.equal(out.flags.get("policy"), "./p.yaml");
});

test("parseArgs: mixed positional + flags", () => {
  const out = parseArgs(["chat", "s_abc", "--message", "hello", "--model=opus"]);
  assert.deepEqual(out.positional, ["chat", "s_abc"]);
  assert.equal(out.flags.get("message"), "hello");
  assert.equal(out.flags.get("model"), "opus");
});

test("parseArgs: value containing = (only first = is the separator)", () => {
  const out = parseArgs(["--filter=key=value"]);
  assert.equal(out.flags.get("filter"), "key=value");
});

test("parseArgs: skills add positional kept after subcommand", () => {
  const out = parseArgs(["skills", "add", "github.com/foo/bar@v1.0.0"]);
  assert.deepEqual(out.positional, ["skills", "add", "github.com/foo/bar@v1.0.0"]);
});

test("parseArgs: --message='' (explicit empty string)", () => {
  const out = parseArgs(["--message="]);
  assert.equal(out.flags.get("message"), "");
});

test("parseArgs: positional preserves order across flags", () => {
  const out = parseArgs(["a", "--x", "1", "b", "--y=2", "c"]);
  assert.deepEqual(out.positional, ["a", "b", "c"]);
  assert.equal(out.flags.get("x"), "1");
  assert.equal(out.flags.get("y"), "2");
});

test("parseArgs: duplicate flags — last one wins", () => {
  const out = parseArgs(["--policy=a", "--policy=b"]);
  assert.equal(out.flags.get("policy"), "b");
});

// ─── `harness do` argv shapes (one-shot mode, ROADMAP §3 #1, issue #21) ──
//
// The one-shot subcommand takes a SINGLE positional task string. Common
// shell invocation puts the task in quotes; argv parsing must keep it
// intact regardless of the surrounding flags.

test("parseArgs: `do` with simple task", () => {
  const out = parseArgs(["do", "what is my disk usage"]);
  assert.deepEqual(out.positional, ["do", "what is my disk usage"]);
  assert.equal(out.flags.size, 0);
});

test("parseArgs: `do` with task + --quiet", () => {
  const out = parseArgs(["do", "list /tmp", "--quiet"]);
  assert.deepEqual(out.positional, ["do", "list /tmp"]);
  assert.equal(out.flags.get("quiet"), true);
});

test("parseArgs: `do` with task + --model + --policy", () => {
  const out = parseArgs([
    "do",
    "renew certs",
    "--model",
    "claude-opus-4-7",
    "--policy=./prod.yaml",
  ]);
  assert.deepEqual(out.positional, ["do", "renew certs"]);
  assert.equal(out.flags.get("model"), "claude-opus-4-7");
  assert.equal(out.flags.get("policy"), "./prod.yaml");
});

test("parseArgs: `do` with task + --allow-unsigned (boolean)", () => {
  const out = parseArgs(["do", "test the local skill", "--allow-unsigned"]);
  assert.deepEqual(out.positional, ["do", "test the local skill"]);
  assert.equal(out.flags.get("allow-unsigned"), true);
});

test("parseArgs: `do` task containing -- inside quotes is preserved", () => {
  // Shell would pass the quoted segment as a single argv element; our
  // parser keeps it as one positional even though it contains hyphens
  // that look like flag prefixes. (Hyphens at non-leading positions
  // inside a token aren't flags.)
  const out = parseArgs(["do", "rebuild --no-cache target"]);
  assert.deepEqual(out.positional, ["do", "rebuild --no-cache target"]);
  assert.equal(out.flags.size, 0);
});

test("parseArgs: `do` without task → positional has only `do`", () => {
  // cmdDo is responsible for surfacing the missing-task error. The
  // parser doesn't validate semantics; this test pins the parse result
  // so that surface-level validation in cmdDo has predictable input.
  const out = parseArgs(["do"]);
  assert.deepEqual(out.positional, ["do"]);
  assert.equal(out.flags.size, 0);
});
