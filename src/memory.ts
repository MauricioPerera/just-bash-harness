// Memory layer over `just-bash-wiki`. Provides cross-session recall +
// per-session compaction by storing facts/turns as wiki sources and
// retrieving them via vector similarity.
//
// Usage:
//   const memory = createMemoryStore({ rootDir: "...", embedder });
//   await memory.remember("user prefers terse responses", { kind: "fact" });
//   const hits = await memory.recall("how should I respond?", { topK: 3 });

import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Bash, ReadWriteFs } from "just-bash";
import { createWikiPlugin } from "just-bash-wiki";
import type { EmbeddingProvider } from "@rckflr/agent-skills-cli";

// ─── public types ──────────────────────────────────────────────────────────

export interface MemoryRecord {
  id: string;
  content: string;
  /** Free-form classifier. Convention: "turn" | "fact" | "summary". */
  kind: string;
  sessionId?: string;
  ts: string;
  /** Cosine similarity to the recall query, if returned by recall(). */
  similarity?: number;
}

export interface MemoryRememberOpts {
  /** Default: "fact". */
  kind?: string;
  sessionId?: string;
  /** ISO timestamp. Default: now. */
  ts?: string;
  /** Wiki requires unique title per source. Default: `${kind}-${ts}`. */
  title?: string;
}

export interface MemoryRecallOpts {
  /** Top-K hits before token budget filter. Default: 5. */
  topK?: number;
  /**
   * Approximate character budget across returned content. Hits are kept in
   * similarity order until adding the next would exceed the budget. Pass
   * undefined for no budget.
   */
  charBudget?: number;
  /** Only return records of this kind. */
  kind?: string;
  /** Only return records belonging to this session. */
  sessionId?: string;
}

export interface MemoryForgetFilter {
  id?: string;
  kind?: string;
  sessionId?: string;
}

export interface Memory {
  /** Persist a memory; returns the wiki source id. */
  remember(content: string, opts?: MemoryRememberOpts): Promise<string>;
  /** Retrieve memories ranked by similarity, optionally filtered + budgeted. */
  recall(query: string, opts?: MemoryRecallOpts): Promise<MemoryRecord[]>;
  /** Delete by id, or all matching kind/sessionId. Returns count deleted. */
  forget(filter: MemoryForgetFilter): Promise<number>;
  /** Shallow listing — title + kind + ts only (no content). */
  list(opts?: { limit?: number; kind?: string }): Promise<
    Array<Pick<MemoryRecord, "id" | "kind" | "ts"> & { title: string }>
  >;
  /** Number of stored memories. */
  size(): Promise<number>;
}

// ─── implementation ────────────────────────────────────────────────────────

export interface MemoryStoreOpts {
  /** Disk dir holding the wiki bank. Created on first use. */
  rootDir: string;
  /** Used for both write-time and recall-time vectorization. */
  embedder: EmbeddingProvider;
  /**
   * Optional AES-256-GCM at rest, forwarded to createWikiPlugin →
   * just-bash-data. The CLI reads the key from
   * `process.env.HARNESS_ENCRYPTION_KEY` when policy.encryption.enabled.
   * Salt is optional namespacing.
   */
  encryptionKey?: string;
  encryptionSalt?: string;
}

import { escSingle } from "./util-escape.js";

export const createMemoryStore = (opts: MemoryStoreOpts): Memory => {
  // The Bash instance type-resolves to whatever `just-bash` is in our
  // node_modules. Other layers (session.ts) use their own copy via
  // createBankBash. Memory is independent of that.
  type BashInstance = InstanceType<typeof Bash>;

  let bash: BashInstance | null = null;
  let initPromise: Promise<void> | null = null;

  const ensureBash = async (): Promise<BashInstance> => {
    if (bash !== null) return bash;
    await mkdir(opts.rootDir, { recursive: true });
    // ReadWriteFs persists to the real disk dir. Without this, just-bash
    // defaults to InMemoryFs and memories vanish at process exit — which
    // defeats the purpose of cross-session memory.
    bash = new Bash({
      fs: new ReadWriteFs({ root: opts.rootDir }),
      customCommands: createWikiPlugin({
        rootDir: "/",
        embeddingDim: opts.embedder.dim,
        ...(opts.encryptionKey !== undefined
          ? { encryptionKey: opts.encryptionKey }
          : {}),
        ...(opts.encryptionSalt !== undefined
          ? { salt: opts.encryptionSalt }
          : {}),
      }),
    });
    if (initPromise === null) {
      initPromise = (async (): Promise<void> => {
        // wiki init is idempotent — second invocation prints "exists" for
        // each collection without recreating. Safe to run on every load.
        const r = await bash!.exec(`wiki init --dim=${opts.embedder.dim}`);
        if (r.exitCode !== 0) {
          throw new Error(`memory init: wiki init failed: ${r.stderr.trim()}`);
        }
      })();
    }
    await initPromise;
    return bash;
  };

  return {
    async remember(content, ropts = {}) {
      const b = await ensureBash();
      const ts = ropts.ts ?? new Date().toISOString();
      const kind = ropts.kind ?? "fact";
      // Wiki requires unique source titles. Encode kind + ts + a short
      // randomUUID slice to avoid collisions when called rapidly.
      // Uses node:crypto for consistency with the rest of the repo
      // (session.ts, loop.ts, rekey.ts all use randomUUID for IDs).
      const titleSalt = randomUUID().slice(0, 6);
      const title = ropts.title ?? `${kind}-${ts}-${titleSalt}`;
      const doc: Record<string, unknown> = {
        title,
        type: kind,
        content,
        author: "harness",
        ...(ropts.sessionId !== undefined ? { session_id: ropts.sessionId } : {}),
        ts,
      };
      const addRes = await b.exec(
        `wiki source add '${escSingle(JSON.stringify(doc))}'`,
      );
      if (addRes.exitCode !== 0) {
        throw new Error(
          `memory.remember: wiki source add exit ${addRes.exitCode}: ${addRes.stderr.trim()}`,
        );
      }
      const { source_id } = JSON.parse(addRes.stdout) as { source_id: string };

      const vector = await opts.embedder.embed(content);
      const embRes = await b.exec(
        `wiki embed source ${source_id} '${escSingle(JSON.stringify(vector))}'`,
      );
      if (embRes.exitCode !== 0) {
        throw new Error(
          `memory.remember: wiki embed exit ${embRes.exitCode}: ${embRes.stderr.trim()}`,
        );
      }
      return source_id;
    },

    async recall(query, ropts = {}) {
      const b = await ensureBash();
      const k = ropts.topK ?? 5;
      const queryVec = await opts.embedder.embed(query);
      const searchRes = await b.exec(
        `wiki search '${escSingle(JSON.stringify(queryVec))}' --k=${k} --type=sources`,
      );
      // exit 3 = no embeddings yet (collection empty). Return empty silently.
      if (searchRes.exitCode === 3) return [];
      if (searchRes.exitCode !== 0) {
        throw new Error(
          `memory.recall: wiki search exit ${searchRes.exitCode}: ${searchRes.stderr.trim()}`,
        );
      }
      const hits = JSON.parse(searchRes.stdout) as Array<{
        id: string;
        score: number;
      }>;

      const records: MemoryRecord[] = [];
      let usedChars = 0;
      const budget = ropts.charBudget ?? Infinity;

      for (const hit of hits) {
        const getRes = await b.exec(`wiki source get ${hit.id}`);
        if (getRes.exitCode !== 0) continue;
        const docs = JSON.parse(getRes.stdout) as Array<{
          _id: string;
          content: string;
          type: string;
          session_id?: string;
          ts?: string;
          ingested_at: string;
        }>;
        if (docs.length === 0) continue;
        const doc = docs[0]!;

        if (ropts.kind !== undefined && doc.type !== ropts.kind) continue;
        if (
          ropts.sessionId !== undefined &&
          doc.session_id !== ropts.sessionId
        )
          continue;

        const recordChars = doc.content.length;
        if (usedChars + recordChars > budget && records.length > 0) break;
        usedChars += recordChars;

        records.push({
          id: doc._id,
          content: doc.content,
          kind: doc.type,
          ...(doc.session_id !== undefined ? { sessionId: doc.session_id } : {}),
          ts: doc.ts ?? doc.ingested_at,
          similarity: hit.score,
        });
      }
      return records;
    },

    async forget(filter) {
      const b = await ensureBash();
      if (filter.id !== undefined) {
        const r = await b.exec(`wiki source delete ${filter.id}`);
        return r.exitCode === 0 ? 1 : 0;
      }
      // Bulk delete by kind / sessionId — list, filter, delete each.
      const flags: string[] = [];
      if (filter.kind !== undefined) flags.push(`--type=${filter.kind}`);
      const listRes = await b.exec(
        `wiki source list ${flags.join(" ")}`.trim(),
      );
      if (listRes.exitCode !== 0) return 0;
      const items = JSON.parse(listRes.stdout) as Array<{ _id: string }>;
      let count = 0;
      for (const item of items) {
        // sessionId requires a per-doc fetch since wiki list doesn't project it
        if (filter.sessionId !== undefined) {
          const getRes = await b.exec(`wiki source get ${item._id}`);
          if (getRes.exitCode !== 0) continue;
          const docs = JSON.parse(getRes.stdout) as Array<{
            session_id?: string;
          }>;
          if (docs[0]?.session_id !== filter.sessionId) continue;
        }
        const delRes = await b.exec(`wiki source delete ${item._id}`);
        if (delRes.exitCode === 0) count++;
      }
      return count;
    },

    async list(lopts = {}) {
      const b = await ensureBash();
      const flags: string[] = [];
      if (lopts.kind !== undefined) flags.push(`--type=${lopts.kind}`);
      const listRes = await b.exec(
        `wiki source list ${flags.join(" ")}`.trim(),
      );
      if (listRes.exitCode !== 0) return [];
      const items = JSON.parse(listRes.stdout) as Array<{
        _id: string;
        title: string;
        type: string;
        ingested_at: string;
      }>;
      const limit = lopts.limit ?? 100;
      return items.slice(0, limit).map((item) => ({
        id: item._id,
        title: item.title,
        kind: item.type,
        ts: item.ingested_at,
      }));
    },

    async size() {
      const b = await ensureBash();
      const r = await b.exec(`wiki source count`);
      if (r.exitCode !== 0) return 0;
      const parsed = JSON.parse(r.stdout) as { count: number };
      return parsed.count;
    },
  };
};
