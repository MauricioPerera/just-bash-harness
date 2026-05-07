// `harness skill init` orchestration. Wraps three primitives from
// agent-skills-cli into a single end-to-end flow:
//
//   1. runInit            — scaffold the skill directory with valid
//                            frontmatter + README + SKILL.md template.
//   2. parseSkillSource   — read the scaffolded SKILL.md back from disk.
//   3. composeEmbeddingText + embedder.embed
//                          — compute the vector representation.
//   4. FileBank.upsertSkill — register the local skill so the toolbox
//                              resolves it like any other skill.
//
// Pre-flight outcome (2026-05-06, recorded in
// `D:/repos/ailibro/CONTRACT-skill-init-command.md` § Pre-flight outcome):
// no upstream coordination required — every primitive exists in
// `@rckflr/agent-skills-cli@~2.3.0`. The contract's earlier ask for
// "gitsign per-skill signing" was a category error against the spec's
// pack-level GPG-signed annotated tag model; this module deliberately
// does NOT sign. Signing happens later when the user moves the skill
// into a pack and runs `agent-skills publish --tag vX.Y.Z --sign`.

import { readFile } from "node:fs/promises";
import { join, isAbsolute, resolve as resolvePath } from "node:path";

import {
  runInit,
  parseSkillSource,
  composeEmbeddingText,
  FileBank,
  type EmbeddingProvider,
  type IndexedSkill,
  type InitResult,
} from "@rckflr/agent-skills-cli";

export interface SkillInitOpts {
  /** Skill id. Lowercase, hyphens, max 64 chars per agent-skills spec. */
  name: string;
  /** Where the scaffold lands. Defaults to `<cwd>/skills/<name>/`. */
  dir?: string;
  /** Scaffold a full pack (multi-skill) instead of a single skill. */
  pack?: boolean;
  /** Skip FileBank registration. Useful for skills authored in a separate
   *  repo destined for upstream packs. */
  noSubscribe?: boolean;
  /** Allow overwriting existing files. Mirrors runInit's `force`. */
  force?: boolean;
  /** Inject `author.name` into scaffolded frontmatter. */
  authorName?: string;
}

export interface SkillInitDeps {
  bank: FileBank;
  embedder: EmbeddingProvider;
}

export interface SkillInitResult {
  /** Pass-through from runInit so callers can render the next-steps. */
  init: InitResult;
  /** True iff FileBank.upsertSkill was called and succeeded. False when
   *  --no-subscribe was passed OR pack mode (no single skill to register). */
  subscribed: boolean;
  /** The synthetic identity stored in the bank when subscribed. */
  identity?: string;
}

/** Build the synthetic identity for a locally-scaffolded skill. The format
 *  satisfies the SPEC §1 shape `<source>@<ref>/<path>` even though the
 *  source is a `local:` URI. The harness uses this consistently so
 *  `harness skills list` and downstream code can recognize local skills
 *  by the `local:` prefix without changing the bank's data model. */
const buildLocalIdentity = (skillId: string, absolutePath: string): string =>
  `local:${absolutePath}@dev/${skillId}`;

/** Find the actual SKILL.md path under init.root. runInit writes
 *  scaffolded skills to `<root>/skills/<name>/SKILL.md`, not `<root>/SKILL.md`,
 *  so we can't assume the layout. We read it off `files_written` to stay
 *  robust to upstream layout changes (e.g. if a future version moves
 *  the skill dir or supports nested namespaces). */
const findSkillMdPath = (
  initRoot: string,
  filesWritten: readonly string[],
): string => {
  const rel = filesWritten.find((f) => f.endsWith("SKILL.md"));
  if (rel === undefined) {
    throw new Error(
      "skill-init: runInit did not report a SKILL.md in files_written. " +
        "This is a contract change in @rckflr/agent-skills-cli that needs investigation.",
    );
  }
  return join(initRoot, rel);
};

/** Read the scaffolded SKILL.md and produce an IndexedSkill ready for
 *  FileBank.upsertSkill. Throws if the file is missing or malformed. */
const buildIndexedSkill = async (
  initRoot: string,
  filesWritten: readonly string[],
  embedder: EmbeddingProvider,
): Promise<IndexedSkill> => {
  const skillMdPath = findSkillMdPath(initRoot, filesWritten);
  const source = await readFile(skillMdPath, "utf8");
  const parsed = parseSkillSource(source);
  const fm = parsed.frontmatter;

  const text = composeEmbeddingText({
    title: fm.title,
    use_when: fm.use_when,
    description: fm.description,
    ...(fm.examples ? { examples: fm.examples } : {}),
    ...(fm.tags ? { tags: fm.tags } : {}),
  });
  const embedding = await embedder.embed(text);

  // The skill's actual on-disk dir is the parent of SKILL.md, i.e.
  // `<init.root>/skills/<name>/`. We use this as the `local:` URI so
  // future code can locate the source if needed.
  const skillDir = skillMdPath.replace(/[\\/]SKILL\.md$/, "");

  const now = new Date().toISOString();
  const identity = buildLocalIdentity(fm.id, skillDir);

  // SkillProvenance.source_type is currently a single-value enum (`"git"`)
  // in the spec. We synthesize a git-typed provenance with a `local:` URI
  // in the source field. The `local:` prefix is the disambiguator until
  // upstream extends the enum to add a real `"local"` source_type
  // (filed as soft follow-up, NOT blocking Phase 1).
  const skill: IndexedSkill = {
    ...fm,
    identity,
    provenance: {
      source_type: "git",
      source: `local:${skillDir}`,
      ref_resolved_to: "dev",
      fetched_at: now,
      signature_status: "unsigned",
    },
    embedding,
    embedding_model: embedder.name,
    inserted_at: now,
    updated_at: now,
  };

  return skill;
};

/** Resolve the user-supplied --dir flag to an absolute path. Falls back
 *  to `<cwd>/skills/` (which is what runInit uses by default when
 *  `dir: "."` is passed plus its internal scaffold layout). */
const resolveDir = (dir: string | undefined): string => {
  if (dir === undefined) return process.cwd();
  return isAbsolute(dir) ? dir : resolvePath(process.cwd(), dir);
};

/**
 * One-shot orchestration entry point. The CLI subcommand thin-wraps this
 * function — keeping it pure-ish (only side effects are the scaffold
 * write, the embedder call, and the bank upsert) makes it
 * unit-testable without going through argv parsing.
 */
export const runSkillInit = async (
  opts: SkillInitOpts,
  deps: SkillInitDeps,
): Promise<SkillInitResult> => {
  const init = await runInit({
    name: opts.name,
    ...(opts.pack !== undefined ? { pack: opts.pack } : {}),
    dir: resolveDir(opts.dir),
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.authorName !== undefined ? { authorName: opts.authorName } : {}),
  });

  // Pack mode scaffolds a multi-skill structure; there's no single skill
  // to register and the user is expected to author skills inside the pack
  // and publish via `agent-skills publish` later. Subscribe step is N/A.
  if (init.mode === "pack") {
    return { init, subscribed: false };
  }

  // Skill mode + --no-subscribe: scaffold-only, exit before bank registration.
  if (opts.noSubscribe === true) {
    return { init, subscribed: false };
  }

  // Skill mode default: read back the scaffolded SKILL.md, embed, register.
  // Force-overwrite via --force re-scaffolds AND re-registers (upsertSkill
  // replaces the existing entry by identity).
  //
  // Edge case: if --force was passed but runInit reported zero
  // files_written (because every file already existed AND was identical
  // with what the template produces), we still want to subscribe — the
  // skill IS on disk, just unchanged. Pass through the empty array; the
  // SKILL.md path is recoverable from the canonical layout.
  const filesForLookup =
    init.files_written.length > 0
      ? init.files_written
      : [join("skills", opts.name, "SKILL.md")];
  const indexed = await buildIndexedSkill(init.root, filesForLookup, deps.embedder);
  await deps.bank.upsertSkill(indexed);

  return { init, subscribed: true, identity: indexed.identity };
};
