/**
 * Shared contracts for the v2 agent harness (spec §4–§6).
 * Provider-agnostic: the Anthropic/Ollama abstraction adapts to ProviderAdapter.
 */

export type ProviderName = "anthropic" | "ollama";

// ---------- Budget ----------

export interface TokenBudget {
  /** Hard cap on input+output tokens across the whole run. */
  maxRunTokens: number;
  /** Soft cap on assembled input per model call (fully enforced by Phase 2 budgeter). */
  maxStepInput: number;
  /** Tokens held back so forced finalization always has room. */
  reserveForFinal: number;
}

export const DEFAULT_BUDGET: TokenBudget = {
  maxRunTokens: 60_000,
  maxStepInput: 12_000,
  reserveForFinal: 3_000,
};

// ---------- Run I/O ----------

export interface TriageRequest {
  ticketId: string;
  subject: string;
  body: string;
}

/** Shape produced by the terminal `triage_ticket` tool call. Align with your v1 tool schema. */
export interface TriageResult {
  category: string;
  priority: "low" | "medium" | "high" | "urgent";
  summary: string;
  /** policy_chunks / resolved_tickets ids the answer is grounded in */
  citations: string[];
  escalated: boolean;
  escalationReason?: string;
}

export interface RunOptions {
  maxSteps?: number; // default 8
  timeoutMs?: number; // default 90_000
  tokenBudget?: Partial<TokenBudget>;
  provider?: ProviderName;
  traceparent?: string; // reserved for Phase 2 tracing
  signal?: AbortSignal; // client disconnect -> "aborted"
}

export type TerminalState =
  | "completed" // agent called triage_ticket / escalate_to_human cleanly
  | "max_steps"
  | "budget_exhausted"
  | "no_terminal_tool" // model kept answering in prose; result came from forced finalization
  | "tool_failure"
  | "aborted";

// ---------- Events streamed by the harness ----------

export type AgentEvent =
  | { type: "run_started"; runId: string; provider: ProviderName; model: string }
  | { type: "step_started"; step: number }
  | { type: "model_delta"; text: string }
  | { type: "tool_call"; step: number; name: string; args: unknown }
  | { type: "tool_result"; step: number; name: string; summary: string; isError: boolean }
  | { type: "loop_guard"; step: number; tool: string; action: "nudged" | "forcing_final" }
  | { type: "compaction"; step: number; droppedApproxTokens: number }
  | { type: "step_completed"; record: StepRecord }
  | { type: "terminal"; state: TerminalState; result?: TriageResult };

// ---------- Persistence records (mirror the Drizzle schema) ----------

export interface StepRecord {
  runId: string;
  stepNo: number;
  /** Populated when tracing is enabled. */
  spanId?: string;
  modelStopReason: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  toolResultsSummary: Array<{ name: string; summary: string; isError: boolean }>;
  scratchpad: string;
  usage: StepUsage;
}

export interface StepUsage {
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// ---------- Provider abstraction ----------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface ChatRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[]; // empty array = tools disabled (forced finalization)
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ProviderTurn {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: StepUsage;
}

/**
 * Adapt your existing Anthropic/Ollama abstraction to this. `onDelta` streams
 * assistant text as it arrives; the resolved ProviderTurn is the complete turn.
 */
export interface ProviderAdapter {
  readonly name: ProviderName;
  readonly model: string;
  chat(req: ChatRequest, onDelta?: (text: string) => void): Promise<ProviderTurn>;
}
