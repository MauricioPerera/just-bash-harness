import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadPolicy, DEFAULT_POLICY } from "./policy.js";

const writeYaml = async (yaml: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "policy-test-"));
  const path = join(dir, "policy.yaml");
  await writeFile(path, yaml, "utf8");
  return path;
};

const cleanup = async (path: string): Promise<void> => {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
};

test("loadPolicy: minimal valid (only version + sessionsRoot) merges defaults", async () => {
  const path = await writeYaml(`
version: 1
paths:
  sessionsRoot: /tmp/x
`);
  try {
    const p = await loadPolicy(path);
    assert.equal(p.version, 1);
    assert.equal(p.paths.sessionsRoot, "/tmp/x");
    // defaults filled in
    assert.equal(p.signature.require_signed, true);
    assert.deepEqual(p.approval.matrix, DEFAULT_POLICY.approval.matrix);
    assert.equal(p.limits.maxTurns, DEFAULT_POLICY.limits.maxTurns);
  } finally {
    await cleanup(path);
  }
});

test("loadPolicy: full override overrides defaults", async () => {
  const path = await writeYaml(`
version: 1
signature:
  require_signed: false
approval:
  matrix:
    prohibited: deny
    explicit: deny
    regular: ask
limits:
  maxTurns: 7
  maxToolCallsPerTurn: 2
  maxWallclockMs: 1000
paths:
  sessionsRoot: /var/sessions
  skillsBankDir: /var/skills
skills:
  subscribed:
    - { pack: github.com/foo/bar, version: v1.0.0 }
  overrides:
    "echo": regular
    "github.com/foo/bar@a1b/sk": prohibited
`);
  try {
    const p = await loadPolicy(path);
    assert.equal(p.signature.require_signed, false);
    assert.equal(p.approval.matrix.regular, "ask");
    assert.equal(p.approval.matrix.explicit, "deny");
    assert.equal(p.limits.maxTurns, 7);
    assert.equal(p.limits.maxWallclockMs, 1000);
    assert.equal(p.paths.skillsBankDir, "/var/skills");
    assert.equal(p.skills.subscribed.length, 1);
    assert.equal(p.skills.overrides["echo"], "regular");
    assert.equal(
      p.skills.overrides["github.com/foo/bar@a1b/sk"],
      "prohibited",
    );
  } finally {
    await cleanup(path);
  }
});

test("loadPolicy: rejects non-object root", async () => {
  const path = await writeYaml(`- not\n- an\n- object\n`);
  try {
    await assert.rejects(loadPolicy(path), /top-level value must be an object/);
  } finally {
    await cleanup(path);
  }
});

test("loadPolicy: rejects unsupported version", async () => {
  const path = await writeYaml(`version: 2\npaths:\n  sessionsRoot: /x\n`);
  try {
    await assert.rejects(loadPolicy(path), /unsupported version/);
  } finally {
    await cleanup(path);
  }
});

test("loadPolicy: rejects invalid override category", async () => {
  const path = await writeYaml(`
version: 1
paths:
  sessionsRoot: /x
skills:
  overrides:
    "bad": "totally-made-up"
`);
  try {
    await assert.rejects(
      loadPolicy(path),
      /skills\.overrides\[bad\] = totally-made-up/,
    );
  } finally {
    await cleanup(path);
  }
});

test("loadPolicy: rejects invalid matrix decision", async () => {
  const path = await writeYaml(`
version: 1
paths:
  sessionsRoot: /x
approval:
  matrix:
    explicit: yolo
`);
  try {
    await assert.rejects(loadPolicy(path), /approval\.matrix\.explicit = yolo/);
  } finally {
    await cleanup(path);
  }
});

test("loadPolicy: missing approval/matrix entries inherit defaults per-key", async () => {
  const path = await writeYaml(`
version: 1
paths:
  sessionsRoot: /x
approval:
  matrix:
    explicit: deny      # only override one
`);
  try {
    const p = await loadPolicy(path);
    assert.equal(p.approval.matrix.prohibited, "deny");        // default kept
    assert.equal(p.approval.matrix.explicit, "deny");          // overridden
    assert.equal(p.approval.matrix.regular, "allow");          // default kept
  } finally {
    await cleanup(path);
  }
});

test("loadPolicy: limits.maxTurns wrong type ignored, default kept", async () => {
  const path = await writeYaml(`
version: 1
paths:
  sessionsRoot: /x
limits:
  maxTurns: "lots"
`);
  try {
    const p = await loadPolicy(path);
    assert.equal(p.limits.maxTurns, DEFAULT_POLICY.limits.maxTurns);
  } finally {
    await cleanup(path);
  }
});

test("loadPolicy: empty subscribed list parses cleanly", async () => {
  const path = await writeYaml(`
version: 1
paths:
  sessionsRoot: /x
skills:
  subscribed: []
`);
  try {
    const p = await loadPolicy(path);
    assert.deepEqual(p.skills.subscribed, []);
    assert.deepEqual(p.skills.overrides, {});
  } finally {
    await cleanup(path);
  }
});

test("DEFAULT_POLICY: shape sanity", () => {
  assert.equal(DEFAULT_POLICY.version, 1);
  assert.equal(DEFAULT_POLICY.signature.require_signed, true);
  assert.equal(DEFAULT_POLICY.approval.matrix.prohibited, "deny");
  assert.equal(DEFAULT_POLICY.approval.matrix.explicit, "ask");
  assert.equal(DEFAULT_POLICY.approval.matrix.regular, "allow");
  assert.ok(DEFAULT_POLICY.limits.maxTurns > 0);
  assert.ok(DEFAULT_POLICY.paths.sessionsRoot.length > 0);
});
