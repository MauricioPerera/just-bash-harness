// Agent loop. The only stateful orchestrator. See DESIGN §4.

import { randomUUID } from "node:crypto";
import { deriveCategory, promptUserApproval } from "./approval.js";
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
      // Append recalled memories to the system prompt. The block is empty
      // when memory is disabled / no recall hit, so this is a no-op cost.
      systemPrompt: baseSystem + memoryBlock,
      history: activeHistory,
      ...(pendingUser !== undefined ? { user: pendingUser } : {}),
      ...(pendingResults !== undefined ? { toolResults: pendingResults } : {}),
      availableTools: tools,
    };
    pendingUser = undefined;
    pendingResults = undefined;

    let stop: StopReason = "error";
    const calls: { id: string; skill: string; args: unknown }[] = [];

    for await (const event of deps.provider.turn(input)) {
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
          calls.push({ id: evt.id, skill: evt.skill, args: evt.args });
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
            redacted: false,
          },
        });
        continue;
      }

      const resolved: ResolvedSkill = { ...summary };
      const derived = deriveCategory(resolved, deps.policy);
      const action: PendingAction = {
        skillId: resolved.id,
        category: derived.category,
        args: (call.args as Record<string, unknown>) ?? {},
        rationale: collectedText.join("").trim().slice(0, 500),
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
        nextResults.push({
          callId: call.id,
          result: {
            ok: false,
            command: "",
            stdout: "",
            stderr: `denied by approval gate (${derived.derivedFrom.join(",")})`,
            exitCode: 126,
            elapsedMs: 0,
            timedOut: false,
            redacted: false,
          },
        });
        continue;
      }

      const result = await deps.toolbox.execute(resolved, action.args, opts.userMessage);
      nextResults.push({ callId: call.id, result });
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
