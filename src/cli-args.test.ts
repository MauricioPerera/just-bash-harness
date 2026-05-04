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
