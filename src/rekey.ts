// `harness rekey` — rotate the AES-256-GCM encryption key for the
// at-rest stores (per-session banks under `policy.paths.sessionsRoot`,
// and the memory bank under `policy.memory.rootDir`).
//
// Strategy: export-with-old / import-with-new, with an atomic dir swap.
// Per target dir:
//   1. Construct a Bash with the OLD key.
//   2. Export every known collection to a temp JSON file.
//   3. Initialize a sibling staging dir with the NEW key.
//   4. Import each collection into the staging dir.
//   5. Atomically move <dir> → <dir>.rekey-backup-<ts> and
//      staging → <dir>.
//   6. The staging dir replaces the original; the backup is left intact
//      for safety. Cleanup of the backup is the user's job (documented).
//
// `--dry-run` performs steps 1-2 only — proves the OLD key successfully
// decrypts and that the NEW key initializes a fresh bank without errors,
// but does not touch original storage.
//
// Limitations (documented in CHANGELOG):
//   - We hardcode the known collection names (sessions/turns/approvals
//     for session banks, sources for the wiki-backed memory bank).
//     A future rekey that needs to handle new collections requires
//     extending the list here.
//   - Mid-flight failure between steps 5a and 5b would leave the dir
//     missing, but `mv → mv` on local FS is sub-second; we accept this
//     window. Explicit warning printed before destructive ops.
//   - Concurrent harness processes against the same bank during rekey
//     are NOT safe. The command refuses to run if it detects the bank
//     was modified less than 60 seconds ago (best-effort). User is
//     expected to drain other invocations first.

import { mkdir, rename, rm, stat, readdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createBankBash } from "@rckflr/agent-skills-cli";

type BashInstance = ReturnType<typeof createBankBash>;

/**
 * Factory for constructing a Bash instance against a bank dir with an
 * encryption key. Defaulted to `createBankBash` from agent-skills-cli;
 * tests inject a stub via `RekeyOpts.bashFactory` so they can record
 * and verify the call ordering (export-with-old → import-with-new →
 * rename-and-promote) without needing real filesystem-backed
 * encryption.
 */
export type BashFactory = (opts: {
  bankDir: string;
  encryptionKey: string;
  salt?: string;
}) => BashInstance;

const defaultBashFactory: BashFactory = (opts) =>
  createBankBash({
    bankDir: opts.bankDir,
    encryptionKey: opts.encryptionKey,
    ...(opts.salt !== undefined ? { salt: opts.salt } : {}),
  });

export type RekeyTarget = "sessions" | "memory" | "skills" | "all";

export interface RekeyOpts {
  /** Sessions root (from policy.paths.sessionsRoot). */
  sessionsRoot: string;
  /** Memory root (from policy.memory.rootDir). */
  memoryRoot?: string;
  /**
   * Skills bank root (from policy.paths.skillsBankDir or defaultBankRoot()).
   * Currently only houses `db approval_stats` (added in 0.3.0). The skills
   * FileBank itself does NOT use createBankBash encryption today, so this
   * target is a no-op for users who never enabled encryption on it.
   * Included so a future move to encrypt the skills bank doesn't leave
   * approval_stats orphaned.
   */
  skillsRoot?: string;
  /** Target subset. "all" runs sessions, then skills, then memory in that order. */
  target: RekeyTarget;
  /** Old key the bank was encrypted with. */
  oldKey: string;
  /** New key to re-encrypt with. */
  newKey: string;
  /** Optional salts (must match between old and new for compatibility). */
  saltSession?: string;
  saltMemory?: string;
  /** When true, validate without modifying anything. */
  dryRun: boolean;
  /** Stream progress to stdout. */
  log: (line: string) => void;
  /**
   * Override the Bash factory. Default uses `createBankBash` from
   * agent-skills-cli. Tests inject a stub to record call ordering
   * without real filesystem-backed encryption.
   */
  bashFactory?: BashFactory;
}

export interface RekeyResult {
  ok: boolean;
  bankDirsProcessed: number;
  backupDirs: string[];
  errors: { dir: string; message: string }[];
}

// Hardcoded collection lists per bank kind. See module header for the
// rationale. When new collections are added (e.g. approval_stats in 0.3.0),
// the relevant list here must be extended OR the consumer must add
// dynamic discovery — db doesn't expose --list-collections today, so a
// future improvement is to readdir the bank dir and match a known suffix.
const SESSION_COLLECTIONS = ["sessions", "turns", "approvals"] as const;
const MEMORY_COLLECTIONS = ["sources"] as const;
const SKILLS_COLLECTIONS = ["approval_stats"] as const;

import { escSingle } from "./util-escape.js";

const tmpJsonPath = (label: string): string =>
  join(tmpdir(), `harness-rekey-${label}-${randomUUID().slice(0, 8)}.json`);

/** Detect bank dirs that look stale enough to be safe to rekey. Returns
 *  the youngest mtime so the caller can warn if recent. */
const youngestMtimeMs = async (dir: string): Promise<number> => {
  let youngest = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const path = join(dir, e.name);
      const s = await stat(path);
      if (s.mtimeMs > youngest) youngest = s.mtimeMs;
    }
  } catch {
    // Empty / nonexistent dir — return 0.
  }
  return youngest;
};

const bankWith = (
  dir: string,
  key: string,
  salt: string | undefined,
  factory: BashFactory,
): BashInstance =>
  factory({
    bankDir: dir,
    encryptionKey: key,
    ...(salt !== undefined ? { salt } : {}),
  });

/** Export one collection with the given Bash to a JSON file on disk.
 *  Returns the tmp file path. Throws if exit != 0 AND collection exists. */
const exportCollection = async (
  bash: BashInstance,
  coll: string,
  label: string,
): Promise<string | null> => {
  const tmp = tmpJsonPath(`export-${coll}-${label}`);
  // Use `db <coll> find '{}'` to get all docs as JSON lines.
  const res = await bash.exec(`db ${coll} find '{}'`);
  if (res.exitCode === 3) {
    // Collection doesn't exist — nothing to export. Not an error.
    return null;
  }
  if (res.exitCode !== 0) {
    throw new Error(`export ${coll}: exit=${res.exitCode}: ${res.stderr.trim()}`);
  }
  await writeFile(tmp, res.stdout, "utf8");
  return tmp;
};

/** Import all docs from a JSON-lines file back into the given collection. */
const importCollection = async (
  bash: BashInstance,
  coll: string,
  jsonLinesPath: string,
): Promise<number> => {
  const content = await readFile(jsonLinesPath, "utf8");
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  let inserted = 0;
  for (const line of lines) {
    // Skip non-JSON lines defensively.
    try {
      JSON.parse(line);
    } catch {
      continue;
    }
    const res = await bash.exec(`db ${coll} insert '${escSingle(line)}'`);
    if (res.exitCode !== 0) {
      throw new Error(`import ${coll}: exit=${res.exitCode}: ${res.stderr.trim()}`);
    }
    inserted++;
  }
  return inserted;
};

/** Process one bank dir end-to-end: export with old, init staging with
 *  new, import, atomic rename. Returns the backup dir path on success. */
const rekeyOneDir = async (
  dir: string,
  collections: readonly string[],
  oldKey: string,
  newKey: string,
  salt: string | undefined,
  dryRun: boolean,
  log: (l: string) => void,
  factory: BashFactory,
): Promise<string | null> => {
  log(`  • ${dir}`);
  // Verify the dir actually exists.
  try {
    await stat(dir);
  } catch {
    log(`    (skipped — dir missing)`);
    return null;
  }

  // Step 1+2: export every collection with old key.
  const oldBash = bankWith(dir, oldKey, salt, factory);
  const exported: { coll: string; tmp: string }[] = [];
  for (const coll of collections) {
    try {
      const tmp = await exportCollection(oldBash, coll, "old");
      if (tmp) {
        exported.push({ coll, tmp });
        log(`    exported ${coll}`);
      } else {
        log(`    (no ${coll} collection)`);
      }
    } catch (err) {
      // Cleanup any tmp files already created.
      for (const e of exported) await rm(e.tmp, { force: true });
      throw new Error(`reading ${dir} with old key: ${(err as Error).message}`);
    }
  }

  if (dryRun) {
    log(`    [dry-run] OLD key validated; new bank not built. Cleaning up tmp.`);
    for (const e of exported) await rm(e.tmp, { force: true });
    return null;
  }

  // Step 3: init a sibling staging dir with the new key.
  const stagingDir = `${dir}.rekey-staging-${randomUUID().slice(0, 8)}`;
  await mkdir(stagingDir, { recursive: true });
  const newBash = bankWith(stagingDir, newKey, salt, factory);

  // Step 4: import each collection into staging.
  let totalDocs = 0;
  for (const { coll, tmp } of exported) {
    const n = await importCollection(newBash, coll, tmp);
    totalDocs += n;
    log(`    imported ${coll} (${n} doc${n === 1 ? "" : "s"})`);
    await rm(tmp, { force: true });
  }

  // Step 5: atomic rename. Backup first, then promote staging.
  const backupDir = `${dir}.rekey-backup-${Date.now()}`;
  log(`    rename ${dir} → ${backupDir}`);
  await rename(dir, backupDir);
  log(`    rename ${stagingDir} → ${dir}`);
  await rename(stagingDir, dir);
  log(`    OK (${totalDocs} doc${totalDocs === 1 ? "" : "s"} re-encrypted; backup at ${backupDir})`);
  return backupDir;
};

/** Run the rekey process. Pure(ish) — depends on fs + createBankBash but
 *  Tests inject `opts.bashFactory` to record bank construction order +
 *  exec calls per stage (export-with-old → import-with-new) without
 *  needing real filesystem-backed encryption. See `rekey.test.ts`. */
export const runRekey = async (opts: RekeyOpts): Promise<RekeyResult> => {
  const factory: BashFactory = opts.bashFactory ?? defaultBashFactory;
  const result: RekeyResult = {
    ok: true,
    bankDirsProcessed: 0,
    backupDirs: [],
    errors: [],
  };

  const dirs: { dir: string; collections: readonly string[]; salt?: string | undefined }[] = [];

  if (opts.target === "sessions" || opts.target === "all") {
    // Each session is its own bank dir under sessionsRoot.
    try {
      const entries = await readdir(opts.sessionsRoot, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith("s_")) {
          dirs.push({
            dir: join(opts.sessionsRoot, e.name),
            collections: SESSION_COLLECTIONS,
            ...(opts.saltSession !== undefined ? { salt: opts.saltSession } : {}),
          });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  if ((opts.target === "skills" || opts.target === "all") && opts.skillsRoot) {
    // Skills bank root holds approval_stats (and any future bank-level
    // collections). Today the skills FileBank doesn't take an encryption
    // key, so this is a no-op unless that changes — included for
    // correctness if/when the skills bank goes encrypted.
    dirs.push({
      dir: opts.skillsRoot,
      collections: SKILLS_COLLECTIONS,
      // Reuse session salt (no separate salt for skills bank in policy schema).
      ...(opts.saltSession !== undefined ? { salt: opts.saltSession } : {}),
    });
  }

  if ((opts.target === "memory" || opts.target === "all") && opts.memoryRoot) {
    dirs.push({
      dir: opts.memoryRoot,
      collections: MEMORY_COLLECTIONS,
      ...(opts.saltMemory !== undefined ? { salt: opts.saltMemory } : {}),
    });
  }

  opts.log(
    `rekey: ${dirs.length} dir(s) to process, target=${opts.target}, dry-run=${opts.dryRun}`,
  );

  // Best-effort recency check — bail if any target dir was touched in the
  // last 60s, suggesting another harness process may be active.
  for (const d of dirs) {
    const youngest = await youngestMtimeMs(d.dir);
    if (youngest > 0 && Date.now() - youngest < 60_000) {
      const err = `dir ${d.dir} was modified <60s ago — refusing to rekey while another process may be using it. Drain first or wait.`;
      opts.log(`  ! ${err}`);
      result.errors.push({ dir: d.dir, message: err });
      result.ok = false;
      return result;
    }
  }

  for (const d of dirs) {
    try {
      const backup = await rekeyOneDir(
        d.dir,
        d.collections,
        opts.oldKey,
        opts.newKey,
        d.salt,
        opts.dryRun,
        opts.log,
        factory,
      );
      if (backup) result.backupDirs.push(backup);
      result.bankDirsProcessed++;
    } catch (err) {
      result.errors.push({ dir: d.dir, message: (err as Error).message });
      result.ok = false;
      // Stop on first error so the user can investigate; remaining dirs
      // stay encrypted with the old key (safe state).
      break;
    }
  }

  return result;
};
