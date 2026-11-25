/**
 * The MCP server's triage path, routed through the v2 agent.
 *
 * This file used to be a stub with its own retrieval and a single Anthropic
 * call, and its own header asked for exactly this change: "so both the HTTP
 * API and this MCP server call the identical code path — no duplicated
 * business logic, and no risk of the two surfaces drifting apart."
 *
 * They had drifted. The stub ranked by distance with no similarity floor, so
 * it returned the three nearest chunks however poor they were; it accepted
 * whatever category the model invented; and nothing checked that a cited
 * chunk had actually been retrieved. Running the agent instead means the MCP
 * surface gets the bounded loop, the 0.65 floor, the fixed taxonomy, citation
 * enforcement against what the run really saw, and escalation when the corpus
 * cannot answer — plus a persisted run in agent_runs/agent_steps that can be
 * scored by the eval suite afterwards.
 *
 * The trade is latency: a loop with retrieval is seconds, not a single call.
 */

import { randomUUID } from "node:crypto";
// Type-only imports: erased at runtime, so loading this module does not
// require the agent to have been built. The runtime itself is imported
// dynamically below — see getRuntime().
import type { AgentRuntime } from "../agent/dist/src/create-harness.js";
import type { AgentEvent, TerminalState } from "../agent/dist/src/types.js";

export interface TriageResult {
  category: string | null;
  priority: "low" | "medium" | "high" | null;
  draft_response: string;
  requires_human_review: boolean;
  escalated: boolean;
  escalation_reason: string | null;
  retrieval_evidence: {
    policy_chunks_used: string[];
    similar_tickets_used: string[];
    /** Best similarity each retrieval tool reported, keyed by tool. */
    top_scores: Record<string, number>;
  };
  /** For joining back to agent_runs / agent_steps / triage_results. */
  run: { id: string | null; terminal_state: TerminalState | null; steps: number };
}

/**
 * One runtime per process: it owns a pg pool. Built lazily so importing this
 * module does not require a database — the MCP server's other tools work
 * without the agent.
 */
let runtime: AgentRuntime | undefined;
async function getRuntime(): Promise<AgentRuntime> {
  if (!runtime) {
    // Imported here, not at module load: a static import would make `npm test`
    // fail on a clean clone, since agent/dist does not exist until the agent is
    // built. Running a triage needs a database anyway, so paying the import
    // cost at first use costs nothing real.
    const { createAgentRuntime } = await import("../agent/dist/src/create-harness.js");
    runtime = createAgentRuntime();
  }
  return runtime;
}

export async function closeTriagePipeline(): Promise<void> {
  await runtime?.close();
  runtime = undefined;
}

/** "urgent" is a valid agent priority but not part of this tool's contract. */
function narrowPriority(p: string | undefined): TriageResult["priority"] {
  if (p === "low" || p === "medium" || p === "high") return p;
  if (p === "urgent") return "high";
  return null;
}

const TOP_SCORE = /top score ([\d.]+)/;

/** Just enough of AgentHarness to run and map a triage, so tests need no database. */
export interface RunnableHarness {
  run(req: { ticketId: string; subject: string; body: string }): AsyncIterable<AgentEvent>;
}

export async function runTriagePipeline(
  params: {
    ticketText: string;
    employeeContext?: { plan_type?: string; enrollment_status?: string };
  },
  /** Injectable for tests; defaults to the process runtime's harness. */
  harnessOverride?: RunnableHarness,
): Promise<TriageResult> {
  const ticketId = `mcp-${randomUUID()}`;
  const harness = harnessOverride ?? ((await getRuntime()).harness as unknown as RunnableHarness);

  // employeeContext has no field on the agent's ticket, and inventing one
  // would change what the model is grounded on. Appended to the body so it is
  // visible to the model without pretending to be retrieved evidence.
  const context = params.employeeContext
    ? Object.entries(params.employeeContext)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")
    : "";

  const top_scores: Record<string, number> = {};
  let runId: string | null = null;
  let terminal: TerminalState | null = null;
  let steps = 0;
  let escalationReason: string | null = null;
  let result: { category?: string; priority?: string; summary?: string; citations?: string[]; escalated?: boolean } | undefined;

  for await (const event of harness.run({
    ticketId,
    subject: params.ticketText.slice(0, 120),
    body: context ? `${params.ticketText}\n\nEmployee context: ${context}` : params.ticketText,
  })) {
    if (event.type === "run_started") runId = event.runId;
    if (event.type === "step_started") steps = event.step;
    if (event.type === "tool_call" && event.name === "escalate_to_human") {
      const reason = (event.args as { reason?: unknown })?.reason;
      if (typeof reason === "string") escalationReason = reason;
    }
    if (event.type === "tool_result" && !event.isError) {
      const m = TOP_SCORE.exec(event.summary);
      if (m) top_scores[event.name] = Number(m[1]);
    }
    if (event.type === "terminal") {
      terminal = event.state;
      result = event.result;
    }
  }

  const citations = result?.citations ?? [];
  const escalated = Boolean(result?.escalated) || escalationReason !== null;

  return {
    category: result?.category ?? null,
    priority: narrowPriority(result?.priority),
    draft_response: result?.summary ?? "",
    // The stub derived this from a model-reported confidence score. The agent
    // reports no confidence, and a fabricated number is worse than none, so
    // this is now grounded in what actually happened: the run escalated, or it
    // did not finish cleanly through a terminal tool.
    requires_human_review: escalated || terminal !== "completed",
    escalated,
    escalation_reason: escalationReason,
    retrieval_evidence: {
      // Enforced at the terminal tool: every id here appeared in a tool result
      // during this run.
      policy_chunks_used: citations.filter((c) => c.startsWith("chunk-")),
      similar_tickets_used: citations.filter((c) => c.startsWith("R-")),
      top_scores,
    },
    run: { id: runId, terminal_state: terminal, steps },
  };
}
