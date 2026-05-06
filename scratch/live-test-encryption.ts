// Encryption smoke: write a memory with key K, verify the disk content is
// NOT plaintext, reload with K → recall works, reload with wrong key → fails
// clean. Then repeat the same verification for the SESSIONS bank to ensure
// both encryption-accepting bank kinds (memory + sessions) preserve the
// invariant. See issue #7 for why the sessions verification is necessary.

import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "@rckflr/agent-skills-cli";

import { createMemoryStore } from "../src/memory.js";
import { createSessionStore } from "../src/session.js";
import type { Policy, Turn } from "../src/types.js";

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

    // ────────────────────────────────────────────────────────────────────
    // SESSIONS BANK VERIFICATION (issue #7)
    //
    // The above five checks validate the memory bank. The sessions bank
    // ALSO accepts an encryption key per `src/session.ts:37-39`, but
    // there was no equivalent smoke until issue #7. The structural
    // similarity (both use createBankBash with encryptionKey) plus the
    // operational asymmetry (only memory was bytes-on-disk verified)
    // would have allowed a regression in createBankBash to silently
    // degrade the sessions encryption without detection. Doctrine #6
    // sub-clause B ("deliberate asymmetries") motivated adding this.
    // ────────────────────────────────────────────────────────────────────
    const sessDir = await mkdtemp(join(tmpdir(), "encrypt-sessions-"));
    console.log("");
    console.log(`sessions dir: ${sessDir}`);

    const SESSION_SECRET =
      "this is a session-only secret — must NOT appear on disk after encryption";

    const buildSessionPolicy = (root: string): Policy => ({
      version: 1,
      skills: { subscribed: [], overrides: {} },
      signature: { require_signed: false },
      approval: {
        matrix: { prohibited: "deny", explicit: "ask", regular: "allow" },
      },
      limits: { maxTurns: 50, maxToolCallsPerTurn: 10, maxWallclockMs: 60_000 },
      paths: { sessionsRoot: root },
      memory: {
        enabled: false,
        rootDir: "",
        recall: { topK: 5, charBudget: 6000 },
        persist: { autoPersistTurns: false, minMessageLength: 20 },
        compaction: { enabled: false, windowSize: 50 },
      },
      encryption: { enabled: true },
    });

    // ── (6) Session: write a turn with KEY_A and a known secret ─────────
    const sessPolicy = buildSessionPolicy(sessDir);
    const sessStoreA = createSessionStore({
      sessionsRoot: sessDir,
      loadPolicy: () => Promise.resolve(sessPolicy),
      encryptionKey: KEY_A,
    });
    const sessId = await sessStoreA.create({
      policyPath: "<encrypt-test>",
      sessionRoot: sessDir,
    });
    const turn: Turn = {
      id: "t_test_001" as Turn["id"],
      ts: new Date().toISOString(),
      input: { user: SESSION_SECRET },
      output: {
        text: "ack: " + SESSION_SECRET,
        toolCalls: [],
        stopReason: "end_turn",
      },
      approvals: [],
    };
    await sessStoreA.appendTurn(sessId, turn);

    // ── (7) Disk content of the session dir must NOT contain plaintext ─
    const sessFiles = await walk(sessDir);
    let sessPlaintextFound = false;
    let sessFoundIn = "";
    for (const f of sessFiles) {
      const buf = await readFile(f).catch(() => Buffer.alloc(0));
      if (buf.includes(Buffer.from(SESSION_SECRET))) {
        sessPlaintextFound = true;
        sessFoundIn = f;
        break;
      }
    }
    check(
      `sessions: secret string not found verbatim on disk (encryption working)`,
      !sessPlaintextFound,
      sessPlaintextFound ? `leaked in ${sessFoundIn}` : "",
    );

    // ── (8) Reload session with same key → load() returns the turn ─────
    const sessStoreA2 = createSessionStore({
      sessionsRoot: sessDir,
      loadPolicy: () => Promise.resolve(sessPolicy),
      encryptionKey: KEY_A,
    });
    const reloaded = await sessStoreA2.load(sessId);
    const turnRecovered =
      reloaded.turns.length === 1 &&
      reloaded.turns[0]!.input.user === SESSION_SECRET;
    check(
      `sessions: load with correct key recovers the turn content`,
      turnRecovered,
      `turns.length=${reloaded.turns.length}, input.user=${JSON.stringify(reloaded.turns[0]?.input.user)?.slice(0, 60)}...`,
    );

    // ── (9) Reload session with WRONG key → load fails or yields empty ──
    const sessStoreWrong = createSessionStore({
      sessionsRoot: sessDir,
      loadPolicy: () => Promise.resolve(sessPolicy),
      encryptionKey: "this-is-the-WRONG-key-totally-different",
    });
    let sessWrongLoaded = false;
    let sessThrew = false;
    let sessRecoveredText: string | undefined;
    try {
      const wrongLoaded = await sessStoreWrong.load(sessId);
      sessWrongLoaded = true;
      sessRecoveredText = wrongLoaded.turns[0]?.input.user;
    } catch {
      sessThrew = true;
    }
    check(
      `sessions: wrong key cannot read the turn content`,
      sessThrew ||
        !sessWrongLoaded ||
        sessRecoveredText !== SESSION_SECRET,
      sessThrew
        ? "(threw — acceptable)"
        : `recovered=${JSON.stringify(sessRecoveredText)?.slice(0, 60)}`,
    );

    // ── (10) Sanity: unencrypted session bank IS readable on disk ──────
    const sessDirPlain = await mkdtemp(join(tmpdir(), "encrypt-sessions-plain-"));
    const sessPlainPolicy = {
      ...buildSessionPolicy(sessDirPlain),
      encryption: { enabled: false } satisfies Policy["encryption"],
    };
    const sessStorePlain = createSessionStore({
      sessionsRoot: sessDirPlain,
      loadPolicy: () => Promise.resolve(sessPlainPolicy),
      // no encryptionKey
    });
    const sessIdPlain = await sessStorePlain.create({
      policyPath: "<encrypt-test-plain>",
      sessionRoot: sessDirPlain,
    });
    const PLAIN_SESSION_SECRET =
      "control: unencrypted session secret should be findable on disk";
    await sessStorePlain.appendTurn(sessIdPlain, {
      ...turn,
      input: { user: PLAIN_SESSION_SECRET },
      output: { ...turn.output, text: PLAIN_SESSION_SECRET },
    });
    const sessPlainFiles = await walk(sessDirPlain);
    let sessPlainFound = false;
    for (const f of sessPlainFiles) {
      const buf = await readFile(f).catch(() => Buffer.alloc(0));
      if (buf.includes(Buffer.from(PLAIN_SESSION_SECRET))) {
        sessPlainFound = true;
        break;
      }
    }
    check(
      `sessions control: unencrypted session IS readable on disk (asymmetry confirmed)`,
      sessPlainFound,
      "expected plaintext findable when encryption is off",
    );
    await rm(sessDirPlain, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessDir, { recursive: true, force: true }).catch(() => undefined);

    console.log("");
    console.log(`${pass}/${pass + fail} checks passed`);

    if (fail === 0) {
      console.log("");
      console.log(
        "PASS — AES-256-GCM at rest works for BOTH memory AND sessions banks: " +
          "secrets unreadable on disk, recoverable with correct key, denied with wrong key.",
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
