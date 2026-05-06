// Unit tests for `runRekey` using a stubbed `bashFactory`.
//
// Background: `rekey.ts` is the highest-blast-radius module in the
// harness — it touches encrypted filesystem state during a key
// rotation, and a bug that doesn't surface in happy-path manual smokes
// can silently corrupt encrypted user data. CHANGELOG `0.3.0`
// acknowledged this as deferred coverage. Issue #8 closes the gap.
//
// Strategy: real filesystem temp dirs (we want to verify rename
// semantics) plus an injected fake Bash that records every `db <coll>
// find/insert` call and lets the test assert the call ordering:
//
//   export-with-old-key (db find on each collection)
//   →
//   import-with-new-key (db insert per doc into staging)
//   →
//   atomic rename old to backup, staging to live
//
// The fake Bash never touches the encryption layer; it just captures
// what runRekey asked it to do, in the order it asked. Combined with
// fs assertions on backup-and-live dir presence, this covers the
// invariants the manual smoke covers but with a deterministic trace.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, mkdir, stat, writeFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runRekey,
  cleanupBackups,
  parseDuration,
  type BashFactory,
} from "./rekey.js";

// ─── fake Bash + factory ────────────────────────────────────────────────────

interface ExecCall {
  bankDir: string;
  key: string;
  cmd: string;
}

interface FakeFactoryState {
  calls: ExecCall[];
  /** Per-collection scripted exports (which `db <coll> find '{}'` returns).
   *  Keyed by collection name. Defaults to empty (collection doesn't exist). */
  exports: Record<string, string>;
  /** Forces every `db <coll> insert` call to fail with the given exit code
   *  and stderr. Lets tests simulate "new key write failure". */
  forceImportFailure?: { exitCode: number; stderr: string };
}

const buildFakeFactory = (
  state: FakeFactoryState,
): BashFactory => {
  return (opts) => ({
    exec: async (cmd: string) => {
      state.calls.push({
        bankDir: opts.bankDir,
        key: opts.encryptionKey,
        cmd,
      });
      // Match `db <coll> find '{}'`
      const findMatch = cmd.match(/^db (\w+) find '\{\}'$/);
      if (findMatch) {
        const coll = findMatch[1]!;
        const exported = state.exports[coll];
        if (exported === undefined) {
          // Simulate "collection doesn't exist" (exit 3 per just-bash-data)
          return { exitCode: 3, stdout: "", stderr: "no such collection" };
        }
        return { exitCode: 0, stdout: exported, stderr: "" };
      }
      // Match `db <coll> insert '<json>'`
      if (/^db \w+ insert '/.test(cmd)) {
        if (state.forceImportFailure !== undefined) {
          return {
            exitCode: state.forceImportFailure.exitCode,
            stdout: "",
            stderr: state.forceImportFailure.stderr,
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Anything else: succeed silently
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    // Other Bash methods aren't called by runRekey. If they ever start
    // being called, tests will fail loudly because these throw.
  } as unknown as ReturnType<BashFactory>);
};

// ─── helpers ────────────────────────────────────────────────────────────────

const makeFakeSessionDir = async (root: string, id = "s_test_001"): Promise<string> => {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  // Touch a file so dir mtime is "old" (beyond the 60s lock check).
  // Then explicitly age it via utimes — but easier: just create the dir
  // and rely on the test running fast enough that the 60s threshold
  // doesn't trip... but it WILL trip, the dir was just created. So:
  // we age the file by setting mtime via fs.utimes.
  // Actually simpler: the 60s check uses youngestMtimeMs. If we make
  // the dir's contents have an older mtime, the check passes.
  const sentinel = join(dir, ".sentinel");
  await writeFile(sentinel, "test\n", "utf8");
  // Set mtime to 5 minutes ago so the rekey 60s lock check passes.
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const fs = await import("node:fs/promises");
  await fs.utimes(sentinel, fiveMinAgo, fiveMinAgo);
  await fs.utimes(dir, fiveMinAgo, fiveMinAgo);
  return dir;
};

const noopLog = (_line: string): void => undefined;
const collectLog = (lines: string[]): ((l: string) => void) => (l) => {
  lines.push(l);
};

// ─── tests ──────────────────────────────────────────────────────────────────

test("runRekey: dry-run validates old key without touching storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "rekey-dryrun-"));
  try {
    const sessionDir = await makeFakeSessionDir(root);
    const state: FakeFactoryState = {
      calls: [],
      exports: { sessions: '{"_id":"s_test_001","createdAt":"2026-05-06"}' },
    };
    const result = await runRekey({
      sessionsRoot: root,
      target: "sessions",
      oldKey: "OLD",
      newKey: "NEW",
      dryRun: true,
      log: noopLog,
      bashFactory: buildFakeFactory(state),
    });
    assert.equal(result.ok, true);
    assert.equal(result.bankDirsProcessed, 1);
    assert.equal(result.backupDirs.length, 0, "dry-run must NOT create backups");
    // Storage state: original dir still there, no staging, no backup
    await stat(sessionDir);
    const entries = await readdir(root);
    const stagingOrBackup = entries.filter(
      (e) => e.includes("rekey-staging-") || e.includes("rekey-backup-"),
    );
    assert.equal(stagingOrBackup.length, 0, `unexpected dirs: ${stagingOrBackup.join(",")}`);
    // All exec calls used OLD key, none used NEW key (dry-run skips import).
    const oldKeyCalls = state.calls.filter((c) => c.key === "OLD");
    const newKeyCalls = state.calls.filter((c) => c.key === "NEW");
    assert.ok(oldKeyCalls.length > 0, "expected at least one OLD-key exec");
    assert.equal(newKeyCalls.length, 0, "dry-run must not call any NEW-key exec");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runRekey: happy path on session bank — export with OLD, import with NEW, atomic rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "rekey-happy-"));
  try {
    const sessionDir = await makeFakeSessionDir(root);
    const state: FakeFactoryState = {
      calls: [],
      exports: {
        sessions: '{"_id":"s_test_001","createdAt":"2026-05-06"}',
        turns: '{"id":"t_001","ts":"2026-05-06"}\n{"id":"t_002","ts":"2026-05-06"}',
        approvals: '{"ts":"2026-05-06","decision":"allow"}',
      },
    };
    const result = await runRekey({
      sessionsRoot: root,
      target: "sessions",
      oldKey: "OLD",
      newKey: "NEW",
      dryRun: false,
      log: noopLog,
      bashFactory: buildFakeFactory(state),
    });
    assert.equal(result.ok, true);
    assert.equal(result.bankDirsProcessed, 1);
    assert.equal(result.backupDirs.length, 1);
    assert.match(result.backupDirs[0]!, /\.rekey-backup-/);
    // Filesystem state: original dir still exists at original path (because
    // staging was renamed onto it). Backup exists with timestamp.
    await stat(sessionDir);
    await stat(result.backupDirs[0]!);
    // Export calls used OLD key, import calls used NEW key.
    const oldFinds = state.calls.filter(
      (c) => c.key === "OLD" && c.cmd.includes("find"),
    );
    const newInserts = state.calls.filter(
      (c) => c.key === "NEW" && c.cmd.includes("insert"),
    );
    assert.equal(oldFinds.length, 3, "should export 3 collections (sessions/turns/approvals)");
    // sessions: 1 doc, turns: 2 docs, approvals: 1 doc → 4 inserts total
    assert.equal(newInserts.length, 4);
    // Strict ordering: every OLD find must precede every NEW insert.
    const lastOldIdx = state.calls.findLastIndex((c) => c.key === "OLD");
    const firstNewIdx = state.calls.findIndex((c) => c.key === "NEW" && c.cmd.includes("insert"));
    assert.ok(
      lastOldIdx < firstNewIdx,
      `export-then-import ordering violated: lastOld=${lastOldIdx}, firstNew=${firstNewIdx}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runRekey: missing session dir is skipped, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "rekey-empty-"));
  try {
    // No session dirs created
    const state: FakeFactoryState = { calls: [], exports: {} };
    const result = await runRekey({
      sessionsRoot: root,
      target: "sessions",
      oldKey: "OLD",
      newKey: "NEW",
      dryRun: false,
      log: noopLog,
      bashFactory: buildFakeFactory(state),
    });
    assert.equal(result.ok, true);
    assert.equal(result.bankDirsProcessed, 0);
    assert.equal(state.calls.length, 0, "no calls when no dirs to process");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runRekey: collection that doesn't exist in old bank is skipped silently", async () => {
  const root = await mkdtemp(join(tmpdir(), "rekey-missingcoll-"));
  try {
    await makeFakeSessionDir(root);
    // Only 'sessions' has data; 'turns' and 'approvals' don't exist
    const state: FakeFactoryState = {
      calls: [],
      exports: { sessions: '{"_id":"s_test_001"}' },
    };
    const result = await runRekey({
      sessionsRoot: root,
      target: "sessions",
      oldKey: "OLD",
      newKey: "NEW",
      dryRun: false,
      log: noopLog,
      bashFactory: buildFakeFactory(state),
    });
    assert.equal(result.ok, true);
    // Only the 1 doc from `sessions` should have been inserted
    const newInserts = state.calls.filter((c) => c.key === "NEW" && c.cmd.includes("insert"));
    assert.equal(newInserts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runRekey: import failure aborts before atomic rename, leaves original intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rekey-importfail-"));
  try {
    const sessionDir = await makeFakeSessionDir(root);
    const state: FakeFactoryState = {
      calls: [],
      exports: { sessions: '{"_id":"s_test_001"}' },
      forceImportFailure: { exitCode: 5, stderr: "simulated insert failure" },
    };
    const result = await runRekey({
      sessionsRoot: root,
      target: "sessions",
      oldKey: "OLD",
      newKey: "NEW",
      dryRun: false,
      log: noopLog,
      bashFactory: buildFakeFactory(state),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /import sessions: exit=5/);
    // Original dir still exists at original path (rename never happened)
    await stat(sessionDir);
    // No backup was created (rename happens AFTER import succeeds)
    assert.equal(result.backupDirs.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runRekey: stops on first error, does not process subsequent dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rekey-multi-"));
  try {
    await makeFakeSessionDir(root, "s_first_one");
    await makeFakeSessionDir(root, "s_second_one");
    const state: FakeFactoryState = {
      calls: [],
      exports: { sessions: '{"_id":"x"}' },
      forceImportFailure: { exitCode: 5, stderr: "fail" },
    };
    const result = await runRekey({
      sessionsRoot: root,
      target: "sessions",
      oldKey: "OLD",
      newKey: "NEW",
      dryRun: false,
      log: noopLog,
      bashFactory: buildFakeFactory(state),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1, "must stop after first failure");
    // Should have processed only one dir before stopping
    const distinctBankDirs = new Set(state.calls.map((c) => c.bankDir));
    // Bank dirs touched: 1 original (export) + 1 staging (import attempt) = 2
    // The second session dir's export should NOT have happened.
    // We can verify by checking how many unique session dirs appear in the OLD-key calls.
    const oldKeyDirs = new Set(
      state.calls.filter((c) => c.key === "OLD").map((c) => c.bankDir),
    );
    assert.equal(oldKeyDirs.size, 1, `expected 1 OLD-key dir touched, got ${oldKeyDirs.size}: ${[...distinctBankDirs].join(", ")}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runRekey: refuses to run if dir was modified <60s ago (best-effort lock)", async () => {
  const root = await mkdtemp(join(tmpdir(), "rekey-fresh-"));
  try {
    const dir = join(root, "s_fresh");
    await mkdir(dir, { recursive: true });
    // Write a sentinel WITHOUT aging it — mtime is "now"
    await writeFile(join(dir, ".sentinel"), "fresh\n", "utf8");
    const state: FakeFactoryState = { calls: [], exports: {} };
    const result = await runRekey({
      sessionsRoot: root,
      target: "sessions",
      oldKey: "OLD",
      newKey: "NEW",
      dryRun: false,
      log: noopLog,
      bashFactory: buildFakeFactory(state),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.message, /modified <60s ago/);
    // No exec calls happened
    assert.equal(state.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runRekey: skills target with skillsRoot is wired and produces no-op when no collections exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "rekey-skills-"));
  try {
    // Create a fake skills bank dir, age it
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".sentinel"), "test\n", "utf8");
    const fs = await import("node:fs/promises");
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    await fs.utimes(join(root, ".sentinel"), fiveMinAgo, fiveMinAgo);
    await fs.utimes(root, fiveMinAgo, fiveMinAgo);
    const state: FakeFactoryState = {
      calls: [],
      // Skills target uses approval_stats — we leave it absent (collection
      // doesn't exist), simulating a fresh install where stats haven't
      // accumulated yet.
      exports: {},
    };
    const result = await runRekey({
      sessionsRoot: "/nonexistent",
      skillsRoot: root,
      target: "skills",
      oldKey: "OLD",
      newKey: "NEW",
      dryRun: false,
      log: noopLog,
      bashFactory: buildFakeFactory(state),
    });
    assert.equal(result.ok, true);
    assert.equal(result.bankDirsProcessed, 1, "skills bank should be considered for rekey");
    // The skills target queried `approval_stats` (got 'collection missing' →
    // skipped) but no actual writes happened.
    const findCalls = state.calls.filter((c) => c.cmd.includes("find"));
    assert.equal(findCalls.length, 1);
    assert.match(findCalls[0]!.cmd, /approval_stats/);
    const insertCalls = state.calls.filter((c) => c.cmd.includes("insert"));
    assert.equal(insertCalls.length, 0, "no inserts when no collections exist");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── parseDuration tests (issue #15) ────────────────────────────────────────

test("parseDuration: numeric forms", () => {
  assert.equal(parseDuration("60s"), 60_000);
  assert.equal(parseDuration("5m"), 5 * 60_000);
  assert.equal(parseDuration("2h"), 2 * 60 * 60_000);
  assert.equal(parseDuration("7d"), 7 * 24 * 60 * 60_000);
  assert.equal(parseDuration("100ms"), 100);
  assert.equal(parseDuration("100"), 100); // raw ms default
});

test("parseDuration: fractional", () => {
  assert.equal(parseDuration("1.5h"), Math.round(1.5 * 60 * 60_000));
});

test("parseDuration: garbage returns null", () => {
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("abc"), null);
  assert.equal(parseDuration("-5d"), null);
  assert.equal(parseDuration("5y"), null); // unsupported unit
});

// ─── cleanupBackups tests (issue #15) ───────────────────────────────────────

test("cleanupBackups: dry-run lists eligible backups, deletes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-dry-"));
  try {
    // Create one live dir + corresponding backup
    const liveDir = join(root, "s_alive");
    const backupDir = join(root, "s_alive.rekey-backup-1717000000000");
    await mkdir(liveDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(liveDir, ".sentinel"), "x", "utf8");
    await writeFile(join(backupDir, ".sentinel"), "x", "utf8");

    const lines: string[] = [];
    const result = await cleanupBackups({
      roots: [root],
      apply: false,
      log: (l) => lines.push(l),
    });

    assert.equal(result.found.length, 1);
    assert.equal(result.eligible.length, 1);
    assert.equal(result.deleted.length, 0, "dry-run must not delete");
    // Backup dir still exists
    await stat(backupDir);
    // Log should mention "would delete"
    assert.ok(lines.some((l) => l.includes("would delete")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupBackups: apply: true actually deletes eligible backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-apply-"));
  try {
    const liveDir = join(root, "s_alive");
    const backupDir = join(root, "s_alive.rekey-backup-1717000000000");
    await mkdir(liveDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(liveDir, ".sentinel"), "x", "utf8");
    await writeFile(join(backupDir, ".sentinel"), "x", "utf8");

    const result = await cleanupBackups({
      roots: [root],
      apply: true,
      log: () => undefined,
    });

    assert.equal(result.found.length, 1);
    assert.equal(result.eligible.length, 1);
    assert.equal(result.deleted.length, 1);
    // Backup dir is gone, live dir still exists
    await assert.rejects(stat(backupDir));
    await stat(liveDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupBackups: REFUSES to delete orphan backup whose live dir is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-orphan-"));
  try {
    // Create ONLY the backup, no live dir — this is "the only copy"
    // and deleting it would be data loss.
    const backupDir = join(root, "s_orphan.rekey-backup-1717000000000");
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, ".data"), "the only copy of this", "utf8");

    const result = await cleanupBackups({
      roots: [root],
      apply: true, // even with apply
      log: () => undefined,
    });

    assert.equal(result.found.length, 1);
    assert.equal(result.eligible.length, 0, "orphan must not be eligible");
    assert.equal(result.skippedOrphans.length, 1);
    assert.equal(result.deleted.length, 0);
    // Backup still there
    await stat(backupDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupBackups: --older-than filter respects age", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-age-"));
  try {
    const liveDir = join(root, "s_alive");
    const youngBackup = join(root, "s_alive.rekey-backup-1717000000000");
    const oldBackup = join(root, "s_alive.rekey-backup-1716000000000");
    await mkdir(liveDir, { recursive: true });
    await mkdir(youngBackup, { recursive: true });
    await mkdir(oldBackup, { recursive: true });
    await writeFile(join(liveDir, ".sentinel"), "x", "utf8");
    await writeFile(join(youngBackup, ".sentinel"), "x", "utf8");
    await writeFile(join(oldBackup, ".sentinel"), "x", "utf8");

    // Age the "old" one to 10 minutes ago
    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(oldBackup, tenMinAgo, tenMinAgo);

    // Only consider backups older than 5 minutes
    const result = await cleanupBackups({
      roots: [root],
      olderThanMs: 5 * 60_000,
      apply: true,
      log: () => undefined,
    });

    assert.equal(result.found.length, 2);
    assert.equal(result.eligible.length, 1, "only the old backup should be eligible");
    assert.equal(result.deleted.length, 1);
    // Old gone, young still there
    await assert.rejects(stat(oldBackup));
    await stat(youngBackup);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanupBackups: ENOENT root is silently skipped, not an error", async () => {
  const result = await cleanupBackups({
    roots: ["/this/path/does/not/exist/12345"],
    apply: true,
    log: () => undefined,
  });
  assert.equal(result.found.length, 0);
  assert.equal(result.errors.length, 0);
});

test("cleanupBackups: non-backup dirs are ignored", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleanup-nonbackup-"));
  try {
    // Make a few dirs that don't match the rekey-backup pattern
    await mkdir(join(root, "s_alive"), { recursive: true });
    await mkdir(join(root, "random_dir"), { recursive: true });
    await mkdir(join(root, "s_alive.rekey-staging-abc"), { recursive: true });

    const result = await cleanupBackups({
      roots: [root],
      apply: true,
      log: () => undefined,
    });

    assert.equal(result.found.length, 0);
    assert.equal(result.deleted.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
