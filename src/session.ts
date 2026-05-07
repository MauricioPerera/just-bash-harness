// Session persistence over a dedicated `createBankBash` instance.
// Validated by scratch/slice.ts: insert/find/export round-trip works.

import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// createBankBash is INTERNAL tier in the CLI. Risk acknowledged in DESIGN §9.
// Note: we deliberately do NOT import `Bash` from "just-bash" here — file:
// dependencies cause TS to see two distinct copies of the type. We type by
// inference from createBankBash's return value.
import { createBankBash } from "@rckflr/agent-skills-cli";

type BashInstance = ReturnType<typeof createBankBash>;

import type {
  Policy,
  Session,
  SessionId,
  SessionOpts,
  SessionStore,
  SnapshotRef,
  Turn,
} from "./types.js";

export interface SessionStoreOpts {
  /** Where session sub-dirs are created (one per session). */
  sessionsRoot: string;
  /** Inject a policy resolver. The store needs the policy at create() time. */
  loadPolicy: (path: string) => Promise<Policy>;
  /**
   * Optional encryption — passed through to createBankBash → just-bash-data
   * for AES-256-GCM at rest. The CLI reads this from
   * `process.env.HARNESS_ENCRYPTION_KEY` when policy.encryption.enabled
   * and forwards it here. Salt is optional namespacing.
   */
  encryptionKey?: string;
  encryptionSalt?: string;
}

const SESSIONS_COLL = "sessions";
const TURNS_COLL = "turns";
const APPROVALS_COLL = "approvals";

const sessionDir = (root: string, id: SessionId): string => join(root, id);

const newSessionId = (): SessionId =>
  // Branded; the harness treats this as opaque.
  `s_${randomUUID().slice(0, 12)}` as SessionId;

import { escSingle } from "./util-escape.js";
const dbInsert = (
  bash: BashInstance,
  coll: string,
  doc: unknown,
): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  bash.exec(`db ${coll} insert '${escSingle(JSON.stringify(doc))}'`);

const expectOk = (
  res: { exitCode: number; stderr: string },
  context: string,
): void => {
  if (res.exitCode !== 0) {
    throw new Error(`${context}: db exited ${res.exitCode}: ${res.stderr.trim()}`);
  }
};

export const createSessionStore = (opts: SessionStoreOpts): SessionStore => {
  // One bash instance per session — keeps state isolated and resume cheap.
  const bashes = new Map<SessionId, BashInstance>();

  const bashFor = (id: SessionId): BashInstance => {
    const existing = bashes.get(id);
    if (existing) return existing;
    const fresh = createBankBash({
      bankDir: sessionDir(opts.sessionsRoot, id),
      ...(opts.encryptionKey !== undefined
        ? { encryptionKey: opts.encryptionKey }
        : {}),
      ...(opts.encryptionSalt !== undefined ? { salt: opts.encryptionSalt } : {}),
    });
    bashes.set(id, fresh);
    return fresh;
  };

  return {
    async create(createOpts: SessionOpts): Promise<SessionId> {
      // customId path is used by `harness do` to land sessions under
      // `<root>/oneshot/<id>`. mkdir({ recursive: true }) handles the
      // intermediate dir creation either way.
      const id = createOpts.customId ?? newSessionId();
      const dir = sessionDir(opts.sessionsRoot, id);
      await mkdir(dir, { recursive: true });

      const policy = await opts.loadPolicy(createOpts.policyPath);
      const bash = bashFor(id);

      const session: Omit<Session, "turns"> = {
        id,
        createdAt: new Date().toISOString(),
        policy,
      };
      const insertRes = await dbInsert(bash, SESSIONS_COLL, { _id: id, ...session });
      expectOk(insertRes, "session.create");
      return id;
    },

    async load(id: SessionId): Promise<Session> {
      // Check the dir exists before constructing a Bash — otherwise just-bash
      // creates the dir lazily and pollutes the sessions root with empty
      // bank dirs for typo'd ids.
      const dir = sessionDir(opts.sessionsRoot, id);
      try {
        await stat(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`session not found: ${id}`);
        }
        throw err;
      }

      const bash = bashFor(id);
      const sessRes = await bash.exec(`db ${SESSIONS_COLL} find '${escSingle(JSON.stringify({ _id: id }))}'`);
      // exit 3 = SESSIONS_COLL is missing. The dir exists (we just stat'd it)
      // but the session doc was never inserted — treat as not-found.
      if (sessRes.exitCode === 3) {
        throw new Error(`session not found: ${id}`);
      }
      expectOk(sessRes, "session.load(session)");
      const sessParsed = JSON.parse(sessRes.stdout) as Array<Session & { _id: string }>;
      if (sessParsed.length === 0) {
        throw new Error(`session not found: ${id}`);
      }
      const sess = sessParsed[0]!;

      const turnsRes = await bash.exec(`db ${TURNS_COLL} find '{}' --sort ts:1`);
      // exit 3 = collection doesn't exist yet (no turns appended). Treat as empty.
      const turns: Turn[] =
        turnsRes.exitCode === 3
          ? []
          : (() => {
              expectOk(turnsRes, "session.load(turns)");
              return (JSON.parse(turnsRes.stdout) as Array<Turn & { _id: string }>) ?? [];
            })();

      return {
        id: sess.id,
        createdAt: sess.createdAt,
        policy: sess.policy,
        turns,
      };
    },

    async appendTurn(id: SessionId, turn: Turn): Promise<void> {
      const bash = bashFor(id);
      const turnRes = await dbInsert(bash, TURNS_COLL, { _id: turn.id, ...turn });
      expectOk(turnRes, "session.appendTurn(turn)");

      // Approvals get their own collection so we can index/filter them later.
      for (const a of turn.approvals) {
        const apRes = await dbInsert(bash, APPROVALS_COLL, {
          _id: `${turn.id}:${a.ts}`,
          turnId: turn.id,
          ...a,
        });
        expectOk(apRes, "session.appendTurn(approval)");
      }
    },

    async snapshot(id: SessionId): Promise<SnapshotRef> {
      const bash = bashFor(id);
      const exports: Record<string, unknown> = {};
      for (const coll of [SESSIONS_COLL, TURNS_COLL, APPROVALS_COLL]) {
        const r = await bash.exec(`db ${coll} export`);
        // exit 3 = collection never created → snapshot it as empty.
        if (r.exitCode === 3) {
          exports[coll] = { exported: 0, docs: [] };
          continue;
        }
        expectOk(r, `session.snapshot(${coll})`);
        exports[coll] = JSON.parse(r.stdout);
      }
      const blob = JSON.stringify({ sessionId: id, exports, ts: new Date().toISOString() });
      const path = join(sessionDir(opts.sessionsRoot, id), `snapshot-${Date.now()}.json`);
      await writeFile(path, blob, "utf8");
      return path as SnapshotRef;
    },

    async resume(id: SessionId): Promise<Session> {
      // For v0, resume = re-open the same session dir. The bash instance
      // backed by createBankBash hydrates from disk on demand.
      // (If the most recent state lives in a snapshot rather than the disk
      // collections, callers should `db <coll> import` from the snapshot
      // explicitly — out of scope for v0.)
      bashes.delete(id); // force fresh bash to re-read from disk
      return this.load(id);
    },

    dispose(id?: SessionId): number {
      // Evict cached bash instances. The Bash holder (just-bash via
      // createBankBash) keeps a child-process + handles open per
      // instance; for one-shot CLI this is a no-op (OS reclaims), but
      // for long-running REPL flows or daemon hosts touching many
      // sessions, dispose() prevents unbounded subprocess accumulation.
      // Returns the count of bashes evicted. Idempotent.
      if (id === undefined) {
        const n = bashes.size;
        bashes.clear();
        return n;
      }
      return bashes.delete(id) ? 1 : 0;
    },
  };
};

// Helper: read a snapshot file and re-import into a session bank.
// Useful for restoring from a backup or moving a session to another machine.
// Not part of the SessionStore interface yet — exported for tests / tooling.
export const restoreSnapshot = async (
  ref: SnapshotRef,
  bash: BashInstance,
): Promise<void> => {
  const text = await readFile(ref, "utf8");
  const blob = JSON.parse(text) as {
    exports: Record<string, { docs: unknown[] }>;
  };
  for (const [coll, payload] of Object.entries(blob.exports)) {
    const arg = JSON.stringify(payload);
    const r = await bash.exec(
      `db ${coll} import '${escSingle(arg)}'`,
    );
    expectOk(r, `restoreSnapshot(${coll})`);
  }
};

export type { Session, SessionId, SessionOpts, Turn, SnapshotRef, SessionStore };
