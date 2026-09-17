import { ContextBudgeter } from "./budgeter.js";
import type { ToolRegistry } from "./registry.js";
import {
  type AgentEvent,
  type ChatRequest,
  type ContentBlock,
  DEFAULT_BUDGET,
  type ModelMessage,
  type ProviderAdapter,
  type RunOptions,
  type StepRecord,
  type TerminalState,
  type TokenBudget,
  type TriageRequest,
  type TriageResult,
} from "./types.js";

export interface LoopDeps {
  provider: ProviderAdapter;
  registry: ToolRegistry;
  runId: string;
  systemPrompt: string;
  /** Injected by the harness; defaults to a summarizer-less budgeter. */
  budgeter?: ContextBudgeter;
}

export interface LoopOutcome {
  state: TerminalState;
  result?: TriageResult;
  stepCount: number;
  totals: { inputTokens: number; outputTokens: number };
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_TIMEOUT_MS = 90_000;
const TEMPERATURE = 0.2;
/** Deterministic key for loop detection: same tool + semantically identical args. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export async function* runLoop(
  deps: LoopDeps,
  req: TriageRequest,
  opts: RunOptions = {},
): AsyncGenerator<AgentEvent, LoopOutcome> {
  const { provider, registry, runId, systemPrompt } = deps;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const budget: TokenBudget = { ...DEFAULT_BUDGET, ...opts.tokenBudget };
  const budgeter = deps.budgeter ?? new ContextBudgeter(budget);
  const startedAt = Date.now();

  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Triage this benefits support ticket.\n\nTicket ID: ${req.ticketId}\nSubject: ${req.subject}\n\n${req.body}`,
        },
      ],
    },
  ];

  const resultSummaries = new Map<string, string>(); // toolUseId -> summary
  const callCounts = new Map<string, number>(); // loop-detection guard
  const totals = { inputTokens: 0, outputTokens: 0 };
  let bareEndTurns = 0;
  let validationRetries = 0;

  const finalize = async function* (
    reason: Exclude<TerminalState, "completed" | "aborted">,
  ): AsyncGenerator<AgentEvent, LoopOutcome> {
    // One last call, tools disabled, JSON-only best-effort answer (spec §4).
    const finalReq: ChatRequest = {
      system:
        systemPrompt +
        "\n\nThe run is being finalized. Using ONLY evidence already gathered above, " +
        "respond with a single JSON object matching the triage_ticket input schema " +
        "(category, priority, summary, citations, escalated). Cite only chunk ids that " +
        "appeared in earlier tool results — never fabricate citations. No prose, no code fences.",
      messages,
      tools: [],
      temperature: 0,
      maxTokens: budget.reserveForFinal,
      signal: opts.signal,
    };
    let result: TriageResult | undefined;
    try {
      const turn = await provider.chat(finalReq);
      totals.inputTokens += turn.usage.inputTokens;
      totals.outputTokens += turn.usage.outputTokens;
      result = JSON.parse(turn.text.trim()) as TriageResult;
    } catch {
      result = undefined; // unparseable best-effort -> terminal without result
    }
    yield { type: "terminal", state: reason, result };
    return { state: reason, result, stepCount: currentStep, totals };
  };

  let currentStep = 0;

  for (let step = 1; step <= maxSteps; step++) {
    currentStep = step;

    if (opts.signal?.aborted) {
      yield { type: "terminal", state: "aborted" };
      return { state: "aborted", stepCount: step - 1, totals };
    }
    if (Date.now() - startedAt > timeoutMs) {
      return yield* finalize("max_steps");
    }
    if (totals.inputTokens + totals.outputTokens >= budget.maxRunTokens - budget.reserveForFinal) {
      return yield* finalize("budget_exhausted");
    }

    yield { type: "step_started", step };

    // Assemble context via the budgeter (spec §6 assembly order).
    const assembly = await budgeter.assemble(messages, resultSummaries);
    const assembled = assembly.messages;
    if (assembly.droppedApproxTokens > 0) {
      yield { type: "compaction", step, droppedApproxTokens: assembly.droppedApproxTokens };
    }

    const deltas: string[] = [];
    let turn;
    try {
      turn = await provider.chat(
        {
          system: systemPrompt,
          messages: assembled,
          tools: registry.specs(),
          temperature: TEMPERATURE,
          maxTokens: 2_000,
          signal: opts.signal,
        },
        (t) => deltas.push(t),
      );
    } catch (err) {
      if (opts.signal?.aborted) {
        yield { type: "terminal", state: "aborted" };
        return { state: "aborted", stepCount: step - 1, totals };
      }
      throw err; // provider failover lives in the harness/provider layer
    }
    for (const t of deltas) yield { type: "model_delta", text: t };

    totals.inputTokens += turn.usage.inputTokens;
    totals.outputTokens += turn.usage.outputTokens;

    const record: StepRecord = {
      runId,
      stepNo: step,
      modelStopReason: turn.stopReason,
      toolCalls: turn.toolCalls.map((c) => ({ name: c.name, args: c.input })),
      toolResultsSummary: [],
      scratchpad: turn.text,
      usage: turn.usage,
    };

    // ----- No tool calls: the model answered in prose -----
    if (turn.toolCalls.length === 0) {
      bareEndTurns++;
      if (bareEndTurns >= 2) {
        yield { type: "step_completed", record };
        return yield* finalize("no_terminal_tool");
      }
      messages.push(
        { role: "assistant", content: [{ type: "text", text: turn.text }] },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Do not answer in prose. Finish by calling triage_ticket (or escalate_to_human if this is out of scope).",
            },
          ],
        },
      );
      yield { type: "step_completed", record };
      continue;
    }

    // ----- Loop-detection guard (spec §5, stop condition 4) -----
    let forceFinal = false;
    let nudge = false;
    for (const call of turn.toolCalls) {
      const key = `${call.name}:${stableStringify(call.input)}`;
      const count = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, count);
      if (count === 2) {
        nudge = true;
        yield { type: "loop_guard", step, tool: call.name, action: "nudged" };
      } else if (count > 2) {
        forceFinal = true;
        yield { type: "loop_guard", step, tool: call.name, action: "forcing_final" };
      }
    }
    if (forceFinal) {
      yield { type: "step_completed", record };
      return yield* finalize("max_steps");
    }

    // ----- Execute tools (read-only tools run in parallel) -----
    const assistantBlocks: ContentBlock[] = [];
    if (turn.text) assistantBlocks.push({ type: "text", text: turn.text });
    for (const c of turn.toolCalls) {
      assistantBlocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    }
    messages.push({ role: "assistant", content: assistantBlocks });

    for (const c of turn.toolCalls) {
      yield { type: "tool_call", step, name: c.name, args: c.input };
    }

    const executions = await Promise.all(
      turn.toolCalls.map((c) =>
        registry
          .execute(c.name, c.input, { runId, step, signal: opts.signal })
          .then((res) => ({ call: c, res })),
      ),
    );

    const resultBlocks: ContentBlock[] = [];
    let unrecoverable = false;
    let terminalResult: TriageResult | undefined;

    for (const { call, res } of executions) {
      if (res.ok) {
        const content = JSON.stringify(res.output.data);
        resultSummaries.set(call.id, res.output.summary);
        resultBlocks.push({ type: "tool_result", toolUseId: call.id, content });
        record.toolResultsSummary.push({
          name: call.name,
          summary: res.output.summary,
          isError: false,
        });
        yield {
          type: "tool_result",
          step,
          name: call.name,
          summary: res.output.summary,
          isError: false,
        };
        if (registry.isTerminal(call.name)) {
          terminalResult = res.validatedArgs as TriageResult;
        }
      } else {
        record.toolResultsSummary.push({
          name: call.name,
          summary: res.error,
          isError: true,
        });
        yield { type: "tool_result", step, name: call.name, summary: res.error, isError: true };
        if (res.kind === "validation") {
          // Surface once for self-correction; second validation failure is unrecoverable.
          validationRetries++;
          if (validationRetries > 1) unrecoverable = true;
          resultBlocks.push({
            type: "tool_result",
            toolUseId: call.id,
            content: `Error: ${res.error}. Correct the arguments and call the tool again.`,
            isError: true,
          });
        } else {
          unrecoverable = true;
          resultBlocks.push({
            type: "tool_result",
            toolUseId: call.id,
            content: `Error: ${res.error}`,
            isError: true,
          });
        }
      }
    }

    messages.push({ role: "user", content: resultBlocks });

    if (nudge) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "You already called that tool with the same arguments. Refine the query or proceed to a final triage with the evidence you have.",
          },
        ],
      });
    }

    yield { type: "step_completed", record };

    if (terminalResult) {
      yield { type: "terminal", state: "completed", result: terminalResult };
      return { state: "completed", result: terminalResult, stepCount: step, totals };
    }
    if (unrecoverable) {
      yield { type: "terminal", state: "tool_failure" };
      return { state: "tool_failure", stepCount: step, totals };
    }
  }

  return yield* finalize("max_steps");
}
