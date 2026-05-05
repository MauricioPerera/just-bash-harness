// Chains smoke (spec §2.8): a parent skill whose `chains` list invokes
// one or more child skills. Verifies:
//   - Children run after the parent
//   - ${VAR} substitution from captured output_vars works
//   - Aggregated stdout includes parent + each chain step
//   - The whole thing surfaces as a single ToolResult (atomic to the LLM)

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileBank, type IndexedSkill } from "@rckflr/agent-skills-cli";

import { createToolbox } from "../src/toolbox.js";
import type { ResolvedSkill, SkillId } from "../src/types.js";

// ─── helpers ──────────────────────────────────────────────────────────────

const stubVec = (dim = 32): number[] =>
  Array.from({ length: dim }, () => 1 / Math.sqrt(dim));

const PACK = "github.com/test/pack@a1b2c3d4e5f67890abcdef1234567890abcdef12";

const baseSkill = (overrides: Partial<IndexedSkill>): IndexedSkill => ({
  identity: `${PACK}/skill` as IndexedSkill["identity"],
  schema_version: "0.1",
  id: "skill",
  version: "1.0.0",
  title: "Skill",
  description: "...",
  use_when: "...",
  command_template: "echo {msg}",
  args: { msg: { type: "string" } },
  idempotent: true,
  provenance: {
    source_type: "git",
    source: "github.com/test/pack",
    ref_resolved_to: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    fetched_at: "2026-04-28T00:00:00Z",
    signature_status: "valid",
  },
  embedding: stubVec(),
  embedding_model: "stub:fnv1a-32",
  inserted_at: "2026-04-28T00:00:00Z",
  updated_at: "2026-04-28T00:00:00Z",
  ...overrides,
});

// ─── main ─────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "chains-test-"));

  try {
    // Three skills, all simple `echo` to avoid hitting just-bash's loop
    // limits. The point of the smoke is the chain mechanism + substitution,
    // not the children's logic.
    //
    //   - parent prints "from-parent"
    //   - step1  prints "step1-saw:<X>" where <X> = ${PARENT_OUTPUT}
    //   - step2  prints "step2-saw:<Y>" where <Y> = ${STEP1_VAR}

    const parent = baseSkill({
      identity: `${PACK}/parent` as IndexedSkill["identity"],
      id: "parent",
      title: "Parent that triggers a chain",
      use_when: "to run a multi-step pipeline",
      command_template: "echo from-parent",
      args: {},
      chains: [
        {
          skill: `${PACK}/step1`,
          args: { x: "${PARENT_OUTPUT}" },
          output_var: "STEP1_VAR",
        },
        {
          skill: `${PACK}/step2`,
          args: { y: "${STEP1_VAR}" },
          // no output_var on final step
        },
      ],
    });

    const step1 = baseSkill({
      identity: `${PACK}/step1` as IndexedSkill["identity"],
      id: "step1",
      title: "Step 1 — consumes parent output",
      use_when: "internal chain step",
      command_template: "echo step1-saw:{x}",
      args: { x: { type: "string" } },
    });

    const step2 = baseSkill({
      identity: `${PACK}/step2` as IndexedSkill["identity"],
      id: "step2",
      title: "Step 2 — consumes step1 output",
      use_when: "internal chain step",
      command_template: "echo step2-saw:{y}",
      args: { y: { type: "string" } },
    });

    const bank = new FileBank({ rootDir: dir });
    await bank.initMeta({ embedding_model: "stub:fnv1a-32", embedding_dim: 32 });
    await bank.upsertSkill(parent);
    await bank.upsertSkill(step1);
    await bank.upsertSkill(step2);

    const toolbox = createToolbox({
      bank,
      embedder: { name: "stub", dim: 32, embed: async () => stubVec() },
      // Disable applicable_when filter so awk doesn't get probed
      filterApplicable: false,
    });

    console.log("=".repeat(72));
    console.log("CHAINS SMOKE — parent + 2 chain steps with ${VAR} substitution");
    console.log("=".repeat(72));

    // Look up the parent as a ResolvedSkill (toolbox.list() preserves chains).
    const tools = await toolbox.list();
    const parentSummary = tools.find((s) => s.shortId === "parent");
    if (!parentSummary) {
      console.error("FAIL — parent not found in toolbox.list()");
      process.exit(1);
    }
    if (!parentSummary.chains || parentSummary.chains.length !== 2) {
      console.error(
        `FAIL — parent.chains expected 2 entries, got ${parentSummary.chains?.length ?? 0}`,
      );
      process.exit(1);
    }
    console.log(
      `parent skill loaded with ${parentSummary.chains.length} chain step(s)`,
    );

    const resolved: ResolvedSkill = { ...parentSummary };
    const result = await toolbox.execute(resolved, {}, "smoke-test");

    console.log("");
    console.log("─── result ──────────────────────────────────────────────");
    console.log(`  ok:        ${result.ok}`);
    console.log(`  exitCode:  ${result.exitCode}`);
    console.log(`  elapsed:   ${result.elapsedMs}ms`);
    console.log(`  command:   ${result.command}`);
    console.log(`  stdout:`);
    for (const line of result.stdout.split("\n")) {
      console.log(`    ${line}`);
    }
    if (result.stderr) {
      console.log(`  stderr:`);
      for (const line of result.stderr.split("\n")) console.log(`    ${line}`);
    }

    console.log("");
    console.log("─── verifications ──────────────────────────────────────");
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

    check("result.ok = true (parent + chain succeeded)", result.ok);
    check("result.exitCode = 0", result.exitCode === 0);
    check(
      "stdout contains parent banner",
      result.stdout.includes("[parent]"),
    );
    check(
      "stdout contains parent's literal output",
      result.stdout.includes("from-parent"),
    );
    check(
      "stdout contains [chain step1] banner",
      result.stdout.includes("[chain step1]"),
    );
    check(
      "step1 received the parent output via ${PARENT_OUTPUT}",
      result.stdout.includes("step1-saw:from-parent"),
    );
    check(
      "stdout contains [chain step2] banner",
      result.stdout.includes("[chain step2]"),
    );
    check(
      "step2 received step1 output via ${STEP1_VAR} (chain-of-vars)",
      result.stdout.includes("step2-saw:step1-saw:from-parent"),
    );

    console.log("");
    console.log(`${pass}/${pass + fail} checks passed`);
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

main().catch((err) => {
  console.error("chains smoke crashed:", err);
  process.exit(2);
});
