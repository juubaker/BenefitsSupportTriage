// @vitest-environment node
//
// The MCP server had no tests at all. These cover the mapping from an agent
// run to the triage_ticket result, which is where the two surfaces could
// drift apart again — the shapes differ, so the translation is real logic.
import { describe, expect, it } from "vitest";
import { runTriagePipeline, type RunnableHarness } from "./triage.js";

type Event = Record<string, unknown>;

/** Replays scripted agent events; records what the harness was asked to run. */
function scriptedHarness(events: Event[]) {
  const seen: Array<{ ticketId: string; subject: string; body: string }> = [];
  const harness: RunnableHarness = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(req: any) {
      seen.push(req);
      return (async function* () {
        for (const e of events) yield e as any;
      })();
    },
  };
  return { harness, seen };
}

const COMPLETED: Event[] = [
  { type: "run_started", runId: "run-1", provider: "anthropic", model: "claude-sonnet-4-6" },
  { type: "step_started", step: 1 },
  {
    type: "tool_result",
    step: 1,
    name: "search_policies",
    isError: false,
    summary: 'search_policies("pcp") -> 1 chunks [chunk-pcp-01], top score 0.84',
  },
  {
    type: "tool_result",
    step: 1,
    name: "find_similar_tickets",
    isError: false,
    summary: "find_similar_tickets -> 1 matches [R-2201], top score 0.71",
  },
  { type: "step_started", step: 2 },
  {
    type: "terminal",
    state: "completed",
    result: {
      category: "plan_administration",
      priority: "low",
      summary: "Change the PCP through the member portal; effective the 1st.",
      citations: ["chunk-pcp-01", "R-2201"],
      escalated: false,
    },
  },
];

describe("runTriagePipeline mapping", () => {
  it("maps a completed run onto the tool's result shape", async () => {
    const { harness } = scriptedHarness(COMPLETED);

    const r = await runTriagePipeline({ ticketText: "How do I change my PCP?" }, harness);

    expect(r.category).toBe("plan_administration");
    expect(r.priority).toBe("low");
    expect(r.draft_response).toContain("member portal");
    expect(r.requires_human_review).toBe(false);
    expect(r.escalated).toBe(false);
    expect(r.run).toEqual({ id: "run-1", terminal_state: "completed", steps: 2 });
  });

  it("splits citations by corpus and keeps each tool's top score", async () => {
    const { harness } = scriptedHarness(COMPLETED);

    const { retrieval_evidence } = await runTriagePipeline({ ticketText: "x" }, harness);

    expect(retrieval_evidence.policy_chunks_used).toEqual(["chunk-pcp-01"]);
    expect(retrieval_evidence.similar_tickets_used).toEqual(["R-2201"]);
    expect(retrieval_evidence.top_scores).toEqual({
      search_policies: 0.84,
      find_similar_tickets: 0.71,
    });
  });

  it("reports an escalation with its reason and flags review", async () => {
    const { harness } = scriptedHarness([
      { type: "run_started", runId: "run-2" },
      { type: "step_started", step: 1 },
      {
        type: "tool_call",
        step: 2,
        name: "escalate_to_human",
        args: { ticketId: "mcp-x", reason: "Payroll request; outside the benefits corpus." },
      },
      { type: "terminal", state: "completed", result: { escalated: true, citations: [] } },
    ]);

    const r = await runTriagePipeline({ ticketText: "Fix my direct deposit" }, harness);

    expect(r.escalated).toBe(true);
    expect(r.escalation_reason).toContain("Payroll");
    expect(r.requires_human_review).toBe(true);
    expect(r.category).toBeNull();
  });

  it("flags review when the run did not finish through a terminal tool", async () => {
    // The old pipeline derived this from a model-reported confidence score.
    // A run that never called a terminal tool is not a decision to trust.
    const { harness } = scriptedHarness([
      { type: "run_started", runId: "run-3" },
      { type: "step_started", step: 1 },
      {
        type: "terminal",
        state: "no_terminal_tool",
        result: { category: "enrollment", priority: "medium", summary: "…", citations: [] },
      },
    ]);

    const r = await runTriagePipeline({ ticketText: "x" }, harness);

    expect(r.requires_human_review).toBe(true);
    expect(r.run.terminal_state).toBe("no_terminal_tool");
  });

  it("narrows urgent to high, since the tool's contract has three levels", async () => {
    const { harness } = scriptedHarness([
      { type: "run_started", runId: "run-4" },
      {
        type: "terminal",
        state: "completed",
        result: { category: "enrollment", priority: "urgent", summary: "…", citations: ["chunk-qle-12"] },
      },
    ]);

    const r = await runTriagePipeline({ ticketText: "x" }, harness);

    expect(r.priority).toBe("high");
  });

  it("passes employee context in the body rather than inventing a ticket field", async () => {
    const { harness, seen } = scriptedHarness(COMPLETED);

    await runTriagePipeline(
      { ticketText: "Am I eligible?", employeeContext: { plan_type: "HDHP", enrollment_status: "active" } },
      harness,
    );

    expect(seen[0].body).toContain("Am I eligible?");
    expect(seen[0].body).toContain("plan_type: HDHP");
    expect(seen[0].body).toContain("enrollment_status: active");
    expect(seen[0].ticketId).toMatch(/^mcp-/);
  });

  it("ignores failed tool results when collecting scores", async () => {
    const { harness } = scriptedHarness([
      { type: "run_started", runId: "run-5" },
      {
        type: "tool_result",
        step: 1,
        name: "search_policies",
        isError: true,
        summary: "Invalid arguments for search_policies: top score 9.99",
      },
      { type: "terminal", state: "completed", result: { citations: [] } },
    ]);

    const r = await runTriagePipeline({ ticketText: "x" }, harness);

    expect(r.retrieval_evidence.top_scores).toEqual({});
  });
});
