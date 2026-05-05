// Agent loop. The only stateful orchestrator. See DESIGN §4.

import { randomUUID } from "node:crypto";
import { deriveCategory, promptUserApproval } from "./approval.js";
import { scrubToolResult } from "./redact.js";
import type { Memory, MemoryRecord } from "./memory.js";
import type {
  ApprovalGate,
  ApprovalRecord,
  PendingAction,
  Policy,
  Provider,
  ResolvedSkill,
  Session,
  SessionStore,
  StopReason,
  ToolCall,
  ToolCallResult,
  Toolbox,
  Turn,
  TurnEvent,
  TurnInput,
} from "./types.js";

export interface LoopDeps {
  provider: Provider;
  toolbox: Toolbox;
  approval: ApprovalGate;
  session: SessionStore;
  policy: Policy;
  /** Optional cross-session memory. When present, recalled before each
   *  user turn and the resulting user/assistant exchange is persisted
   *  after end_turn (subject to policy.memory.persist settings). */
  memory?: Memory;
}

/** Render recalled memories into a system-prompt block. Order preserved
 *  (similarity already applied in recall). */
const formatMemoryContext = (records: readonly MemoryRecord[]): string =>
  records
    .map((r, i) => {
      const sim = r.similarity !== undefined
        ? ` similarity=${r.similarity.toFixed(3)}`
        : "";
      return `[${i + 1}] ${r.kind} (${r.ts}${sim}):\n${r.content}`;
    })
    .join("\n\n");

export interface LoopHandlers {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolCall?: (id: string, skillId: string) => void;
  /** Called when the gate returns 'ask'. Default: TTY prompt. */
  onApprovalAsk?: (action: PendingAction) => Promise<"allow" | "deny">;
}

export interface RunOpts {
  sessionId: Session["id"];
  userMessage: string;
  systemPrompt?: string;
  handlers?: LoopHandlers;
  signal?: AbortSignal;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are an agent running in a sandboxed bash harness. Use the available skills via tool calls when they help. Keep responses focused.";

const newTurnId = () => `t_${randomUUID().slice(0, 12)}` as Turn["id"];

const SUMMARY_SYSTEM_PROMPT =
  "You are summarizing a chunk of an agent conversation that is about to fall out of the active context window. " +
  "Produce a structured digest covering: " +
  "(1) the user's intent / what they're working on, " +
  "(2) decisions made and tools called with their key outcomes, " +
  "(3) any open threads or blockers. " +
  "Be specific about file paths, identifiers, and concrete results. " +
  "Avoid restating tool stdout verbatim — extract what mattered. " +
  "The summary will be prepended to subsequent turns' system prompt as 'Earlier conversation digest'.";

/**
 * Render dropped turns as a single user message string for the summarizer.
 * We don't pass tool_results back through the provider's history machinery
 * — this is a one-shot summarization call with one synthetic user message.
 */
const formatDroppedTurnsForSummary = (turns: readonly Turn[]): string => {
  const parts: string[] = [];
  for (const t of turns) {
    if (t.input.user) parts.push(`USER: ${t.input.user}`);
    if (t.output.text) parts.push(`ASSISTANT: ${t.output.text}`);
    if (t.output.toolCalls.length > 0) {
      const calls = t.output.toolCalls
        .map((c) => `- ${c.skillId.split("/").at(-1) ?? c.skillId}(${JSON.stringify(c.args).slice(0, 200)})`)
        .join("\n");
      parts.push(`TOOLS_CALLED:\n${calls}`);
    }
    if (t.input.toolResults && t.input.toolResults.length > 0) {
      const results = t.input.toolResults
        .map((r) => `- callId=${r.callId} ok=${r.result.ok} stdout=${r.result.stdout.slice(0, 300)}`)
        .join("\n");
      parts.push(`TOOL_RESULTS:\n${results}`);
    }
  }
  return parts.join("\n\n");
};

/**
 * Run one summarization pass through the same provider. Collects all text
 * events into a single string. Tools / chains are not invoked — we set
 * availableTools to []. The provider's stop reason is ignored; we trust
 * the text up to the first stop event.
 */
export const runCompactionSummary = async (
  provider: Provider,
  droppedTurns: readonly Turn[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> => {
  const userBlock = formatDroppedTurnsForSummary(droppedTurns);
  // Brief safeguard: cap input size so we don't blow the provider's
  // own input limit. 50K chars is generous for most contexts; tools that
  // need more should bump windowSize instead.
  const cappedUser = userBlock.length > 50_000
    ? userBlock.slice(0, 50_000) + "\n[... truncated for summary call ...]"
    : userBlock;

  const summaryInput: TurnInput = {
    systemPrompt: SUMMARY_SYSTEM_PROMPT + ` Output budget: ~${maxTokens} tokens.`,
    history: [],
    user: cappedUser,
    availableTools: [],
  };
  const collected: string[] = [];
  for await (const evt of provider.turn(summaryInput, signal)) {
    if (evt.type === "text") collected.push(evt.delta);
    if (evt.type === "stop") break;
  }
  return collected.join("");
};

/**
 * Build a synthetic worst-case ResolvedSkill for a chain step whose target
 * identity is not in the bank (e.g. the parent declared `chains: [{ skill:
 * "github.com/foo/bar/skills/typo@v1" }]` but no such skill resolved).
 *
 * Treated as the worst case so `deriveCategory` rejects the union — fail
 * closed. The parent's metadata is used as scaffolding only for the fields
 * that don't matter for derivation; the four capability fields below are
 * forced to maximum-restriction values.
 *
 * Exported so this fail-closed contract can be unit-tested in isolation —
 * regression catch for the v0.2.3 lesson that orchestration features must
 * not bypass approval invariants.
 */
export const synthesizeUnknownChainStep = (
  parent: ResolvedSkill,
  stepSkillId: string,
): ResolvedSkill => ({
  ...parent, // scaffolding for non-capability fields (title, description, etc.)
  id: stepSkillId,
  shortId: stepSkillId.split("/").at(-1) ?? stepSkillId,
  signatureStatus: "unsigned",
  network: ["*"],
  filesystem: ["*"],
  idempotent: false,
});

export const runTurn = async (
  deps: LoopDeps,
  opts: RunOpts,
): Promise<Turn> => {
  const session = await deps.session.load(opts.sessionId);
  if (session.turns.length >= deps.policy.limits.maxTurns) {
    throw new Error(
      `loop: session ${opts.sessionId} hit maxTurns (${deps.policy.limits.maxTurns}). v0 does not auto-compact.`,
    );
  }

  const onAsk = opts.handlers?.onApprovalAsk ?? promptUserApproval;
  const startedAt = Date.now();
  const wallclockBudget = deps.policy.limits.maxWallclockMs;

  const tools = await deps.toolbox.list();

  // Recall memory once per `runTurn` invocation, keyed off the user's
  // current message. Cross-session by default; per-session scope is opted
  // in via deps.memory's caller (typically the CLI passes sessionId in
  // policy-driven setups).
  let memoryBlock = "";
  if (
    deps.memory &&
    deps.policy.memory.enabled &&
    opts.userMessage !== undefined &&
    opts.userMessage.trim().length > 0
  ) {
    try {
      const recalled = await deps.memory.recall(opts.userMessage, {
        topK: deps.policy.memory.recall.topK,
        charBudget: deps.policy.memory.recall.charBudget,
      });
      if (recalled.length > 0) {
        memoryBlock = `\n\n## Relevant memories from past turns\n${formatMemoryContext(recalled)}`;
      }
    } catch (err) {
      // Memory failures are non-fatal — log to onText is too noisy, just
      // emit to stderr if a thinking handler exists.
      opts.handlers?.onThinking?.(
        `[memory.recall failed: ${(err as Error).message}]\n`,
      );
    }
  }

  // Compaction: cap the active history window. Each session.turns entry is
  // a complete user-message-to-end_turn cycle (appendTurn called once at
  // the end of each runTurn invocation), so slicing the array gives clean
  // tool_use/tool_result pairing at the boundary.
  //
  // Older turns remain in `db turns` (full audit) AND in memory (auto-
  // persisted as turn-kind records during their original runTurn). The
  // memory recall earlier in this function brings back relevant snippets,
  // so semantic context is preserved.
  const compactionCfg = deps.policy.memory.compaction;
  const fullHistory = session.turns;
  const activeHistory =
    deps.memory &&
    deps.policy.memory.enabled &&
    compactionCfg.enabled &&
    fullHistory.length > compactionCfg.windowSize
      ? fullHistory.slice(-compactionCfg.windowSize)
      : fullHistory;

  // When compaction trims history AND summarize.enabled, generate a
  // rolling summary of the dropped turns and prepend it to the system
  // prompt. The summary is built by asking the same provider for a
  // structured digest of the dropped block. Cost: one extra provider
  // call with maxTokens cap. See issue #1 for design rationale.
  let compactionSummaryBlock = "";
  const droppedTurns = fullHistory.slice(0, fullHistory.length - activeHistory.length);
  const summarizeCfg = compactionCfg.summarize;
  if (
    summarizeCfg?.enabled &&
    droppedTurns.length > 0 &&
    deps.policy.memory.enabled
  ) {
    try {
      opts.handlers?.onThinking?.(
        `[compaction-summary: requesting digest of ${droppedTurns.length} dropped turn(s) (max ${summarizeCfg.maxTokens} tokens)]\n`,
      );
      const summary = await runCompactionSummary(
        deps.provider,
        droppedTurns,
        summarizeCfg.maxTokens,
        opts.signal,
      );
      if (summary.trim().length > 0) {
        compactionSummaryBlock = `\n\n## Earlier conversation digest (compaction summary)\n${summary.trim()}`;
        // Persist the summary to memory so it's recallable on later runs.
        if (deps.memory) {
          try {
            await deps.memory.remember(summary, {
              kind: "compaction-summary",
              sessionId: String(opts.sessionId),
              ts: new Date().toISOString(),
            });
          } catch (err) {
            opts.handlers?.onThinking?.(
              `[compaction-summary persist failed: ${(err as Error).message}]\n`,
            );
          }
        }
      }
    } catch (err) {
      opts.handlers?.onThinking?.(
        `[compaction-summary failed: ${(err as Error).message}]\n`,
      );
    }
  }

  if (activeHistory.length < fullHistory.length) {
    const dropped = fullHistory.length - activeHistory.length;
    opts.handlers?.onThinking?.(
      `[compaction: ${dropped} older turn(s) dropped from active history; recall covers them]\n`,
    );
  }

  // Outer driver. We may run multiple provider.turn() rounds within ONE
  // user-message turn if the model emits tool calls and then expects to
  // continue. That's what 'tool_use' stop reason means.
  const turnId = newTurnId();
  const collectedText: string[] = [];
  const collectedThinking: string[] = [];
  const toolCalls: ToolCall[] = [];
  const approvals: ApprovalRecord[] = [];
  const toolResultsBuffer: ToolCallResult[] = [];
  let finalStop: StopReason = "end_turn";

  let pendingUser: string | undefined = opts.userMessage;
  let pendingResults: ToolCallResult[] | undefined;

  // Cap iterations to maxToolCallsPerTurn; if we somehow loop more, abort.
  for (let iter = 0; iter <= deps.policy.limits.maxToolCallsPerTurn; iter++) {
    if (Date.now() - startedAt > wallclockBudget) {
      finalStop = "cancelled";
      break;
    }

    const baseSystem = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    const input: TurnInput = {
      // Order: base prompt, then compaction summary (digest of dropped
      // turns — most recent context that the active window doesn't cover),
      // then recalled memories (older / cross-session context). Both
      // blocks are empty in the common case so this is a no-op cost.
      systemPrompt: baseSystem + compactionSummaryBlock + memoryBlock,
      history: activeHistory,
      ...(pendingUser !== undefined ? { user: pendingUser } : {}),
      ...(pendingResults !== undefined ? { toolResults: pendingResults } : {}),
      availableTools: tools,
    };
    pendingUser = undefined;
    pendingResults = undefined;

    let stop: StopReason = "error";
    const calls: {
      id: string;
      skill: string;
      args: unknown;
      /** Text accumulated up to the moment this tool_call event arrived.
       *  Captured per-call so each PendingAction.rationale reflects what the
       *  LLM said *before* deciding to invoke that specific tool, not the
       *  full text including narration that came after later tool calls. */
      rationale: string;
    }[] = [];

    for await (const event of deps.provider.turn(input, opts.signal)) {
      if (opts.signal?.aborted) {
        stop = "cancelled";
        break;
      }
      const evt: TurnEvent = event;
      switch (evt.type) {
        case "text":
          collectedText.push(evt.delta);
          opts.handlers?.onText?.(evt.delta);
          break;
        case "thinking":
          collectedThinking.push(evt.delta);
          opts.handlers?.onThinking?.(evt.delta);
          break;
        case "tool_call":
          calls.push({
            id: evt.id,
            skill: evt.skill,
            args: evt.args,
            rationale: collectedText.join("").trim().slice(0, 500),
          });
          opts.handlers?.onToolCall?.(evt.id, evt.skill);
          break;
        case "stop":
          stop = evt.reason;
          break;
      }
    }

    if (calls.length === 0 || stop !== "tool_use") {
      finalStop = stop;
      break;
    }

    // Resolve, gate, execute each tool call sequentially. Spec doesn't allow
    // parallel skill exec yet (audit ordering expects serial) and the
    // approval prompt would interleave anyway.
    //
    // We don't call resolve(intent) here because the LLM has already chosen
    // a skill by id. List is enough for the id → SkillSummary lookup needed
    // for approval derivation.
    const skillsList = await deps.toolbox.list();
    const summaryById = new Map(skillsList.map((s) => [s.id, s]));

    const nextResults: ToolCallResult[] = [];
    for (const call of calls) {
      // Find the skill summary to derive category. If the model invented an
      // identity that isn't in our bank, treat as prohibited.
      const summary = summaryById.get(call.skill);
      if (!summary) {
        nextResults.push({
          callId: call.id,
          result: {
            ok: false,
            command: "",
            stdout: "",
            stderr: `unknown skill: ${call.skill}`,
            exitCode: 127,
            elapsedMs: 0,
            timedOut: false,
          },
        });
        continue;
      }

      const resolved: ResolvedSkill = { ...summary };

      // Resolve chain step identities to ResolvedSkills so deriveCategory
      // can compute the union over parent + all chain steps. A chain step
      // pointing at an unknown skill is treated as the worst case
      // (prohibited via missing-skill marker).
      const chainSkills: ResolvedSkill[] = [];
      for (const step of resolved.chains ?? []) {
        const stepSummary = summaryById.get(step.skill);
        if (stepSummary === undefined) {
          chainSkills.push(synthesizeUnknownChainStep(resolved, step.skill));
        } else {
          chainSkills.push({ ...stepSummary });
        }
      }

      const derived = deriveCategory(resolved, deps.policy, chainSkills);
      const action: PendingAction = {
        skillId: resolved.id,
        category: derived.category,
        args: (call.args as Record<string, unknown>) ?? {},
        rationale: call.rationale,
        derivedFrom: derived.derivedFrom,
      };

      let decision = await deps.approval.check(action);
      if (decision === "ask") {
        const userDecision = await onAsk(action);
        decision = userDecision;
        const record: ApprovalRecord = {
          ts: new Date().toISOString(),
          action,
          decision,
          source: "user",
        };
        approvals.push(record);
        await deps.approval.record(record);
      } else {
        const record: ApprovalRecord = {
          ts: new Date().toISOString(),
          action,
          decision,
          source: "policy",
        };
        approvals.push(record);
        await deps.approval.record(record);
      }

      toolCalls.push({
        id: call.id,
        skillId: resolved.id,
        args: action.args,
      });
      if (decision === "deny") {
        // Friendlier error when signature was the cause of the deny — this
        // is the most common DX trip for new users (default policy enforces
        // signed-only). Otherwise fall back to the raw derivedFrom list.
        const signatureReason = derived.derivedFrom.find((r) =>
          r.includes("signature:"),
        );
        const stderr = signatureReason
          ? `denied by approval gate: skill is unsigned and policy.signature.require_signed=true. ` +
            `Reason chain: ${derived.derivedFrom.join(", ")}. ` +
            `Fix options: (a) sign the skill / pack via gitsign or GitHub OIDC, ` +
            `(b) add a policy override entry mapping this skill id to 'regular' or 'explicit', ` +
            `(c) re-invoke with --allow-unsigned (development only — drops the signature gate for the entire policy).`
          : `denied by approval gate (${derived.derivedFrom.join(",")})`;
        nextResults.push({
          callId: call.id,
          result: {
            ok: false,
            command: "",
            stdout: "",
            stderr,
            exitCode: 126,
            elapsedMs: 0,
            timedOut: false,
          },
        });
        continue;
      }

      const result = await deps.toolbox.execute(resolved, action.args, opts.userMessage);
      // Redact known secret patterns before the result reaches any
      // persistence sink (db turns, memory) or the next provider call.
      // Defense in depth — even if a skill prints a token, the audit
      // record AND the LLM context see [REDACTED:<kind>:<len>] instead.
      // Phase 1: conservative pattern set (see src/redact.ts).
      const scrubbed = scrubToolResult(result);
      // `redacted` is now optional on ToolResult (since 0.3.0). scrubToolResult
      // always sets it, but TS only knows the public-type contract.
      if ((scrubbed.redacted ?? 0) > 0) {
        opts.handlers?.onThinking?.(
          `[redact: ${scrubbed.redacted} secret(s) scrubbed from ${resolved.shortId} output]\n`,
        );
      }
      nextResults.push({ callId: call.id, result: scrubbed });
    }

    toolResultsBuffer.push(...nextResults);
    pendingResults = nextResults;
    // Loop back to provider with toolResults; stop loop when model emits 'end_turn'.
  }

  const turn: Turn = {
    id: turnId,
    ts: new Date().toISOString(),
    input: {
      ...(opts.userMessage !== undefined ? { user: opts.userMessage } : {}),
      ...(toolResultsBuffer.length > 0 ? { toolResults: toolResultsBuffer } : {}),
    },
    output: {
      text: collectedText.join(""),
      toolCalls,
      ...(collectedThinking.length > 0 ? { thinking: collectedThinking.join("") } : {}),
      stopReason: finalStop,
    },
    approvals,
  };

  await deps.session.appendTurn(opts.sessionId, turn);

  // Persist memory: only on a clean end_turn AND only if the user said
  // something AND the assistant's reply is non-trivial. Tool-only turns
  // (no text output) don't make useful memories on their own.
  const persistCfg = deps.policy.memory.persist;
  const finalText = collectedText.join("");
  if (
    deps.memory &&
    deps.policy.memory.enabled &&
    persistCfg.autoPersistTurns &&
    finalStop === "end_turn" &&
    opts.userMessage !== undefined &&
    finalText.length >= persistCfg.minMessageLength
  ) {
    try {
      await deps.memory.remember(
        `User: ${opts.userMessage}\nAssistant: ${finalText}`,
        {
          kind: "turn",
          sessionId: String(opts.sessionId),
          ts: turn.ts,
        },
      );
    } catch (err) {
      opts.handlers?.onThinking?.(
        `[memory.remember failed: ${(err as Error).message}]\n`,
      );
    }
  }

  return turn;
};
