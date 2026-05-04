// Policy loader. Immutable for the session per DESIGN §3.5.
//
// The harness's policy intentionally has NO network/filesystem allowlist —
// each skill declares its own (`network: []`, `filesystem: []`) and the CLI
// enforces them at exec time. We don't duplicate that here.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { Policy, ApprovalCategory } from "./types.js";

const VALID_CATEGORIES: readonly ApprovalCategory[] = [
  "prohibited",
  "explicit",
  "regular",
];
const VALID_DECISIONS = ["allow", "deny", "ask"] as const;

export const DEFAULT_POLICY: Policy = {
  version: 1,
  skills: {
    subscribed: [],
    overrides: {},
  },
  signature: {
    require_signed: true,
  },
  approval: {
    matrix: {
      prohibited: "deny",
      explicit: "ask",
      regular: "allow",
    },
  },
  limits: {
    maxTurns: 50,
    maxToolCallsPerTurn: 10,
    maxWallclockMs: 10 * 60 * 1000, // 10 min
  },
  paths: {
    sessionsRoot: join(homedir(), ".harness", "sessions"),
  },
};

export const loadPolicy = async (path: string): Promise<Policy> => {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  return mergeWithDefaults(parsed);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const mergeWithDefaults = (input: unknown): Policy => {
  if (!isObject(input)) {
    throw new Error("policy: top-level value must be an object");
  }
  if (input.version !== 1) {
    throw new Error(`policy: unsupported version ${String(input.version)} (expected 1)`);
  }

  // skills
  const skillsIn = isObject(input.skills) ? input.skills : {};
  const subscribed = Array.isArray(skillsIn.subscribed)
    ? (skillsIn.subscribed as ReadonlyArray<{ pack: string; version: string }>)
    : DEFAULT_POLICY.skills.subscribed;
  const overridesIn = isObject(skillsIn.overrides) ? skillsIn.overrides : {};
  const overrides: Record<string, ApprovalCategory> = {};
  for (const [k, v] of Object.entries(overridesIn)) {
    if (typeof v === "string" && (VALID_CATEGORIES as readonly string[]).includes(v)) {
      overrides[k] = v as ApprovalCategory;
    } else {
      throw new Error(`policy: skills.overrides[${k}] = ${String(v)} (must be ${VALID_CATEGORIES.join("|")})`);
    }
  }

  // signature
  const sigIn = isObject(input.signature) ? input.signature : {};
  const require_signed =
    typeof sigIn.require_signed === "boolean"
      ? sigIn.require_signed
      : DEFAULT_POLICY.signature.require_signed;

  // approval
  const apIn = isObject(input.approval) ? input.approval : {};
  const matrixIn = isObject(apIn.matrix) ? apIn.matrix : {};
  const matrix = { ...DEFAULT_POLICY.approval.matrix };
  for (const cat of VALID_CATEGORIES) {
    const v = matrixIn[cat];
    if (v === undefined) continue;
    if (!(VALID_DECISIONS as readonly string[]).includes(v as string)) {
      throw new Error(`policy: approval.matrix.${cat} = ${String(v)} (must be ${VALID_DECISIONS.join("|")})`);
    }
    matrix[cat] = v as Policy["approval"]["matrix"][ApprovalCategory];
  }

  // limits
  const limIn = isObject(input.limits) ? input.limits : {};
  const limits = {
    maxTurns: typeof limIn.maxTurns === "number" ? limIn.maxTurns : DEFAULT_POLICY.limits.maxTurns,
    maxToolCallsPerTurn:
      typeof limIn.maxToolCallsPerTurn === "number"
        ? limIn.maxToolCallsPerTurn
        : DEFAULT_POLICY.limits.maxToolCallsPerTurn,
    maxWallclockMs:
      typeof limIn.maxWallclockMs === "number"
        ? limIn.maxWallclockMs
        : DEFAULT_POLICY.limits.maxWallclockMs,
  };

  // paths
  const pathsIn = isObject(input.paths) ? input.paths : {};
  if (typeof pathsIn.sessionsRoot !== "string" && DEFAULT_POLICY.paths.sessionsRoot === undefined) {
    throw new Error("policy: paths.sessionsRoot is required");
  }
  const paths: Policy["paths"] = {
    sessionsRoot:
      typeof pathsIn.sessionsRoot === "string"
        ? pathsIn.sessionsRoot
        : DEFAULT_POLICY.paths.sessionsRoot,
    ...(typeof pathsIn.skillsBankDir === "string"
      ? { skillsBankDir: pathsIn.skillsBankDir }
      : {}),
    ...(typeof pathsIn.auditLogPath === "string"
      ? { auditLogPath: pathsIn.auditLogPath }
      : {}),
  };

  return {
    version: 1,
    skills: { subscribed, overrides },
    signature: { require_signed },
    approval: { matrix },
    limits,
    paths,
  };
};
