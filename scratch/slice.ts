// Vertical slice — validate that the harness's intended integration with
// agent-skills-cli + just-bash + just-bash-data actually works.
//
// What this answers:
//   1. Can we import runQuery / runExec / FileBank programmatically? (✓ if it runs)
//   2. Does FileBank.appendAudit work from harness code?            (✓ if list returns 1)
//   3. Can we open a SECOND just-bash backed by createBankBash on a
//      separate dir for harness session storage, and use db / vec
//      commands directly?                                            (✓ if insert/find work)
//   4. Does `db export` produce a usable blob for snapshots?         (✓ if blob non-empty)
//
// Output: prints PASS/FAIL per question + JSON of what each step returned.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileBank,
  runExec,
  type IndexedSkill,
  // INTERNAL — we accept the coupling for the slice.
  createBankBash,
} from "@rckflr/agent-skills-cli";

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const buildEchoSkill = (): IndexedSkill => ({
  identity: "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12/echo-skill",
  schema_version: "0.1",
  id: "echo-skill",
  version: "1.0.0",
  title: "Echo a message",
  description: "Echoes the given message to stdout",
  use_when: "you need to print a string",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
  provenance: {
    source_type: "git",
    source: "github.com/test/pack",
    ref_resolved_to: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    fetched_at: new Date().toISOString(),
    signature_status: "unsigned",
  },
  embedding: stubVec(),
  embedding_model: "stub:fnv1a-32",
  inserted_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

interface Step {
  name: string;
  ok: boolean;
  detail: unknown;
  error?: string;
}

const run = async (): Promise<void> => {
  const steps: Step[] = [];
  const skillsBankDir = await mkdtemp(join(tmpdir(), "harness-slice-skills-"));
  const sessionBankDir = await mkdtemp(join(tmpdir(), "harness-slice-session-"));

  try {
    // ─── (1) FileBank + runExec ────────────────────────────────────
    const bank = new FileBank({ rootDir: skillsBankDir });
    await bank.upsertSkill(buildEchoSkill());

    try {
      const result = await runExec({
        bank,
        skillIdentifier: "echo-skill",
        args: { msg: "hello from harness" },
        intent: "say hello",
      });
      steps.push({
        name: "1-runExec",
        ok: result.exit_code === 0 && result.stdout.includes("hello from harness"),
        detail: {
          exit_code: result.exit_code,
          stdout: result.stdout.trim(),
          command: result.command,
          elapsed_ms: result.elapsed_ms,
        },
      });
    } catch (err) {
      steps.push({ name: "1-runExec", ok: false, detail: null, error: String(err) });
    }

    // ─── (2) bank.appendAudit + listAudit ──────────────────────────
    try {
      // listAudit reflects what runExec wrote (which uses appendAudit internally).
      const audit = await bank.listAudit({ limit: 10 });
      steps.push({
        name: "2-audit-readback",
        ok: audit.length >= 1,
        detail: { count: audit.length, last: audit.at(-1) ?? null },
      });
    } catch (err) {
      steps.push({ name: "2-audit-readback", ok: false, detail: null, error: String(err) });
    }

    // ─── (3) Independent bash for session storage via createBankBash ─
    let sessionBash;
    try {
      sessionBash = createBankBash({ bankDir: sessionBankDir });

      // Insert a session record.
      const insertRes = await sessionBash.exec(
        `db sessions insert '{"_id":"sess-1","ts":"${new Date().toISOString()}","user":"slice","msg":"hello"}'`,
      );

      // Find it back.
      const findRes = await sessionBash.exec(`db sessions find '{"_id":"sess-1"}'`);

      const inserted = insertRes.exitCode === 0;
      const found =
        findRes.exitCode === 0 &&
        findRes.stdout.includes("sess-1") &&
        findRes.stdout.includes("hello");

      steps.push({
        name: "3-session-bash-db",
        ok: inserted && found,
        detail: {
          insert: { exitCode: insertRes.exitCode, stdout: insertRes.stdout.trim().slice(0, 200) },
          find: { exitCode: findRes.exitCode, stdout: findRes.stdout.trim().slice(0, 200) },
        },
      });
    } catch (err) {
      steps.push({ name: "3-session-bash-db", ok: false, detail: null, error: String(err) });
    }

    // ─── (4) db export → blob ──────────────────────────────────────
    try {
      if (!sessionBash) throw new Error("no sessionBash from step 3");
      const exportRes = await sessionBash.exec(`db sessions export`);
      const blob = exportRes.stdout;
      steps.push({
        name: "4-db-export",
        ok: exportRes.exitCode === 0 && blob.length > 0 && blob.includes("sess-1"),
        detail: {
          exitCode: exportRes.exitCode,
          bytes: blob.length,
          preview: blob.slice(0, 200),
        },
      });
    } catch (err) {
      steps.push({ name: "4-db-export", ok: false, detail: null, error: String(err) });
    }
  } finally {
    await rm(skillsBankDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessionBankDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ─── Report ─────────────────────────────────────────────────────
  console.log("=".repeat(70));
  console.log("HARNESS VERTICAL SLICE — RESULTS");
  console.log("=".repeat(70));
  for (const s of steps) {
    console.log(`\n[${s.ok ? "PASS" : "FAIL"}] ${s.name}`);
    if (s.error) console.log("  error:", s.error);
    console.log("  detail:", JSON.stringify(s.detail, null, 2).split("\n").map((l, i) => i === 0 ? l : "          " + l).join("\n"));
  }
  console.log("\n" + "=".repeat(70));
  const passed = steps.filter((s) => s.ok).length;
  console.log(`${passed} / ${steps.length} steps passed`);
  console.log("=".repeat(70));
  process.exit(passed === steps.length ? 0 : 1);
};

run().catch((err) => {
  console.error("slice crashed:", err);
  process.exit(2);
});
