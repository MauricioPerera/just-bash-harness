// Encryption smoke: write a memory with key K, verify the disk content is
// NOT plaintext, reload with K → recall works, reload with wrong key → fails
// clean.

import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "@rckflr/agent-skills-cli";

import { createMemoryStore } from "../src/memory.js";

// Toy embedder, same as memory.test.ts.
const toyEmbedder = (dim = 32): EmbeddingProvider => ({
  name: "toy",
  dim,
  async embed(text) {
    const v = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[i % dim]! += (text.charCodeAt(i) % 17) / 17;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  },
});

const SECRET = "the quick brown fox jumps over the lazy dog and asks for terse responses";

const main = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "encrypt-"));
  console.log("=".repeat(72));
  console.log("ENCRYPTION SMOKE");
  console.log("=".repeat(72));
  console.log(`memory dir: ${dir}`);

  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, hint?: string): void => {
    if (ok) {
      console.log(`  ✓ ${name}`);
      pass++;
    } else {
      console.log(`  ✗ ${name}${hint ? ` — ${hint}` : ""}`);
      fail++;
    }
  };

  try {
    // ── (1) Write with encryption key K ────────────────────────────────
    const KEY_A = "test-key-A-correct";
    const memA = createMemoryStore({
      rootDir: dir,
      embedder: toyEmbedder(32),
      encryptionKey: KEY_A,
    });
    const id = await memA.remember(SECRET, { kind: "fact" });
    console.log(`  wrote memory id=${id} with key A`);

    // ── (2) Disk content must NOT contain plaintext ────────────────────
    // Walk the wiki dir; ensure no file contains the known secret string.
    const walk = async (root: string): Promise<string[]> => {
      const out: string[] = [];
      const entries = await readdir(root, { withFileTypes: true });
      for (const e of entries) {
        const path = join(root, e.name);
        if (e.isDirectory()) out.push(...(await walk(path)));
        else out.push(path);
      }
      return out;
    };
    const files = await walk(dir);
    let plaintextFound = false;
    let foundIn = "";
    for (const f of files) {
      const buf = await readFile(f).catch(() => Buffer.alloc(0));
      if (buf.includes(Buffer.from(SECRET))) {
        plaintextFound = true;
        foundIn = f;
        break;
      }
    }
    check(
      `secret string not found verbatim on disk (encryption working)`,
      !plaintextFound,
      plaintextFound ? `leaked in ${foundIn}` : "",
    );

    // ── (3) Reload with same key → recall returns the secret ──────────
    // Fresh memory store instance to simulate a new process.
    const memA2 = createMemoryStore({
      rootDir: dir,
      embedder: toyEmbedder(32),
      encryptionKey: KEY_A,
    });
    const hits = await memA2.recall("fox terse", { topK: 5 });
    check(
      `recall with correct key surfaces the original content`,
      hits.length > 0 && hits[0]!.content === SECRET,
      `hits[0].content=${JSON.stringify(hits[0]?.content?.slice(0, 60))}...`,
    );

    // ── (4) Reload with WRONG key → fails clean (no plaintext leak) ───
    // just-bash-data's encrypted-bin adapter detects bad keys at load and
    // surfaces an error. We expect either an exception or empty/garbage
    // results — NOT a successful read of plaintext.
    const memWrong = createMemoryStore({
      rootDir: dir,
      embedder: toyEmbedder(32),
      encryptionKey: "this-is-the-WRONG-key-totally-different",
    });
    let recalledWithWrongKey: string | undefined;
    let threwOnWrongKey = false;
    try {
      const wrongHits = await memWrong.recall("fox terse", { topK: 5 });
      recalledWithWrongKey = wrongHits[0]?.content;
    } catch {
      threwOnWrongKey = true;
    }
    check(
      `wrong key cannot read the secret`,
      threwOnWrongKey || recalledWithWrongKey !== SECRET,
      threwOnWrongKey
        ? "(threw — acceptable)"
        : `recovered content=${JSON.stringify(recalledWithWrongKey)?.slice(0, 60)}`,
    );

    // ── (5) Sanity: writing without a key in a NEW dir leaves disk plaintext-readable ─
    const dirPlain = await mkdtemp(join(tmpdir(), "encrypt-plain-"));
    const memPlain = createMemoryStore({
      rootDir: dirPlain,
      embedder: toyEmbedder(32),
      // no encryptionKey
    });
    const PLAIN_SECRET = "this should be readable on disk because no key";
    await memPlain.remember(PLAIN_SECRET, { kind: "fact" });
    const plainFiles = await walk(dirPlain);
    let plainFoundOnDisk = false;
    for (const f of plainFiles) {
      const buf = await readFile(f).catch(() => Buffer.alloc(0));
      if (buf.includes(Buffer.from(PLAIN_SECRET))) {
        plainFoundOnDisk = true;
        break;
      }
    }
    check(
      `control: unencrypted memory IS readable on disk (asymmetry confirmed)`,
      plainFoundOnDisk,
      "expected plaintext to be findable when encryption is off",
    );
    await rm(dirPlain, { recursive: true, force: true }).catch(() => undefined);

    console.log("");
    console.log(`${pass}/${pass + fail} checks passed`);

    if (fail === 0) {
      console.log("");
      console.log(
        "PASS — AES-256-GCM at rest works: secret unreadable on disk, recoverable with correct key, denied with wrong key.",
      );
      process.exit(0);
    }
    process.exit(1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

main().catch((err) => {
  console.error("encryption smoke crashed:", err);
  process.exit(2);
});
