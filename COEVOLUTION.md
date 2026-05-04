# Co-Evolution Plan — harness ↔ ecosystem

Status: **draft v0.2** · 2026-05-04

After reading the actual code in the four user-owned repos and running a vertical slice (see `scratch/slice.ts`), most of what was proposed in v0.1 of this document already exists. This is the corrected list.

## Summary

| # (was) | Original proposal | Reality | Status |
|---|---|---|---|
| C1 | Add `category` field for approval | Field exists as free-form filtering; we DERIVE a security category from existing `network`/`filesystem`/`idempotent`/`signature_status` instead | ❌ cancelled |
| C2 | Programmatic API on `agent-skills-cli` | Already shipped at STABLE tier (v2.3.0): `runQuery`, `runExec`, `FileBank`, `createBankBash`, embedders, signature verifiers | ✅ done |
| C3 | Per-skill `network` allowlist | Already in spec §2.10 as `network: string[]` | ✅ done |
| C5 | `db.snapshot/restore` | `db <coll> export` and `db <coll> import` already exist (also for `vec`) | ✅ done |
| C7 | Mandatory `commitSha` | `provenance.ref_resolved_to` always populated; `enforceVerification` already implements signature gate | ✅ done (it's policy, not schema) |

## Genuine open items (much shorter list)

| # | Change | Repo | Why | Priority |
|---|---|---|---|---|
| O1 | Promote `createBankBash` from INTERNAL → STABLE tier | agent-skills-cli | Harness depends on it; INTERNAL tier may break in minor releases | Med — pin minor version meanwhile |
| O2 | `runChat`-like primitive: `(intent, args, decisionFn) → ToolResult` | agent-skills-cli | Currently every consumer composes `runQuery` + own gate + `runExec`. A single primitive would standardize the contract | Low — harness owns this composition fine |
| O3 | Streaming `runExec`: emit chunks as they arrive | agent-skills-cli | Long-running tools currently block until full completion; UX hit | Low — defer until a long tool actually hurts |
| O4 | `wiki ingest-turn` + `wiki query-context --token-budget` | just-bash-wiki | Compaction needs budget-aware retrieval, not result-count-aware | Med — needed only when v0 hits maxTurns |

## Conventions to document (no code changes)

- **Use `wiki source add` to ingest turns** for the future compaction path. The schema is already permissive enough; we just need to agree on a `type: "conversation-turn"` convention.
- **Pin `@rckflr/agent-skills-cli` to a minor version** in any harness that depends on `createBankBash`, until O1 lands.
- **Treat `runExec`'s sandbox as the boundary.** Don't introduce harness-level sandbox abstractions; they will diverge from the CLI's enforcement.

## What this means for v0

The harness is mostly a *consumer* of the existing surfaces, not a co-evolution exercise. It can ship without any upstream changes. O1 is the only one that's worth scheduling alongside; the rest are only needed once concrete issues bite.
