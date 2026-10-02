import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentHarness, MemoryRunStore } from "../src/harness.js";
import { ToolRegistry } from "../src/registry.js";
import { FakeProvider, type ScriptedTurn } from "../src/testing/fake-provider.js";
import type { AgentEvent, TriageRequest } from "../src/types.js";

const TICKET: TriageRequest = {
  ticketId: "T-100",
  subject: "Adding spouse after job loss",
  body: "My spouse lost her job last week. Can I add her to my plan mid-year?",
};

const FINAL = {
  category: "enrollment",
  priority: "high",
  summary: "QLE: spousal loss of coverage; special enrollment applies.",
  citations: ["chunk-qle-12"],
  escalated: false,
};

function buildTestRegistry() {
  const registry = new ToolRegistry();
  const calls: Array<{ name: string; args: unknown }> = [];
  registry.register({
    name: "search_policies",
    description: "search",
    schema: z.object({ query: z.string().min(3), k: z.number().int().default(5) }),
    handler: async (args) => {
      calls.push({ name: "search_policies", args });
      return {
        data: [{ chunkId: "chunk-qle-12", text: "QLE special enrollment...", score: 0.91 }],
        summary: "1 chunk, top 0.91",
      };
    },
  });
  registry.register({
    name: "triage_ticket",
    description: "terminal",
    schema: z.object({
      category: z.string(),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      summary: z.string(),
      citations: z.array(z.string()),
      escalated: z.boolean(),
    }),
    terminal: true,
    handler: async (args) => {
      calls.push({ name: "triage_ticket", args });
      return { data: { saved: true }, summary: "saved" };
    },
  });
  return { registry, calls };
}

async function collect(turns: ScriptedTurn[], opts: Parameters<AgentHarness["run"]>[1] = {}) {
  const { registry, calls } = buildTestRegistry();
  const provider = new FakeProvider(turns);
  const store = new MemoryRunStore();
  const harness = new AgentHarness({
    providers: { ollama: provider },
    defaultProvider: "ollama",
    registry,
    store,
    systemPrompt: "test system prompt",
  });
  const events: AgentEvent[] = [];
  for await (const e of harness.run(TICKET, opts)) events.push(e);
  const terminal = events.find((e) => e.type === "terminal");
  return { events, terminal, store, calls, provider };
}

describe("agent loop", () => {
  it("completes cleanly when the model gathers evidence then calls triage_ticket", async () => {
    const { terminal, store, calls } = await collect([
      { text: "Searching policies.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage QLE", k: 5 } }] },
      { text: "Evidence sufficient.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
    ]);
    expect(terminal).toMatchObject({ state: "completed", result: FINAL });
    expect(calls.map((c) => c.name)).toEqual(["search_policies", "triage_ticket"]);
    expect(store.steps).toHaveLength(2);
    expect(store.ledger).toHaveLength(2);
    const run = [...store.runs.values()][0];
    expect(run).toMatchObject({ terminalState: "completed", stepCount: 2 });
  });

  it("hits max_steps and forces a best-effort finalization with tools disabled", async () => {
    const searchTurn = (i: number): ScriptedTurn => ({
      toolCalls: [{ name: "search_policies", input: { query: `angle ${i} on the ticket`, k: 5 } }],
    });
    const { terminal, provider } = await collect(
      [
        searchTurn(1),
        searchTurn(2),
        { text: `{"category":"enrollment","priority":"high","summary":"best effort","citations":["chunk-qle-12"],"escalated":false}` },
      ],
      { maxSteps: 2 },
    );
    expect(terminal).toMatchObject({ state: "max_steps" });
    expect((terminal as Extract<AgentEvent, { type: "terminal" }>).result?.summary).toBe("best effort");
    const finalReq = provider.requests.at(-1)!;
    expect(finalReq.tools).toHaveLength(0);
    expect(finalReq.system).toContain("finalized");
  });

  it("nudges on a repeated identical tool call, then forces finalization on the third", async () => {
    const same = { name: "search_policies", input: { k: 5, query: "spouse coverage" } };
    const sameReordered = { name: "search_policies", input: { query: "spouse coverage", k: 5 } };
    const { events, terminal } = await collect([
      { toolCalls: [same] },
      { toolCalls: [sameReordered] }, // key order differs; stableStringify must still match
      { toolCalls: [same] },
      { text: `{"category":"enrollment","priority":"high","summary":"forced","citations":[],"escalated":false}` },
    ]);
    const guards = events.filter((e) => e.type === "loop_guard");
    expect(guards.map((g) => (g as { action: string }).action)).toEqual(["nudged", "forcing_final"]);
    expect(terminal).toMatchObject({ state: "max_steps" });
  });

  it("surfaces a validation error for self-correction, then completes", async () => {
    const { events, terminal } = await collect([
      { toolCalls: [{ name: "search_policies", input: { query: "ab" } }] }, // too short -> Zod fail
      { toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
      { toolCalls: [{ name: "triage_ticket", input: FINAL }] },
    ]);
    const errorResult = events.find((e) => e.type === "tool_result" && e.isError);
    expect(errorResult).toBeDefined();
    expect(terminal).toMatchObject({ state: "completed" });
  });

  it("stops with budget_exhausted before starting a step it cannot afford", async () => {
    const { terminal, store } = await collect(
      [
        { toolCalls: [{ name: "search_policies", input: { query: "spouse coverage rules" } }], usage: { inputTokens: 45_000, outputTokens: 15_000 } },
        { text: `{"category":"enrollment","priority":"high","summary":"budget","citations":[],"escalated":false}` },
      ],
      { tokenBudget: { maxRunTokens: 60_000, reserveForFinal: 3_000 } },
    );
    expect(terminal).toMatchObject({ state: "budget_exhausted" });
    const run = [...store.runs.values()][0];
    expect(run.terminalState).toBe("budget_exhausted");
  });

  it("nudges once when the model answers in prose, finalizes on the second bare answer", async () => {
    const { terminal, provider } = await collect([
      { text: "The answer is that a QLE applies." },
      { text: "As I said, a QLE applies." },
      { text: `{"category":"enrollment","priority":"high","summary":"no terminal tool","citations":[],"escalated":false}` },
    ]);
    expect(terminal).toMatchObject({ state: "no_terminal_tool" });
    // The nudge landed in the message history of the second request.
    const secondReq = provider.requests[1];
    const flat = JSON.stringify(secondReq.messages);
    expect(flat).toContain("Do not answer in prose");
  });

  it("aborts when the client disconnects", async () => {
    const abort = new AbortController();
    abort.abort();
    const { terminal, store } = await collect(
      [{ toolCalls: [{ name: "search_policies", input: { query: "spouse coverage" } }] }],
      { signal: abort.signal },
    );
    expect(terminal).toMatchObject({ state: "aborted" });
    expect([...store.runs.values()][0].terminalState).toBe("aborted");
  });
});

describe("run totals when the consumer stops at terminal", () => {
  it("records token usage even if the generator is disposed early", async () => {
    // The SSE route breaks out of the for-await on the terminal event, which
    // disposes the loop generator before its return value — the authoritative
    // totals — is ever observed. The run row must still be right.
    const { registry } = buildTestRegistry();
    const store = new MemoryRunStore();
    const harness = new AgentHarness({
      providers: {
        ollama: new FakeProvider([
          { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
          { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
        ]),
      },
      defaultProvider: "ollama",
      registry,
      store,
      systemPrompt: "test system prompt",
    });

    for await (const event of harness.run(TICKET)) {
      if (event.type === "terminal") break;
    }

    const run = [...store.runs.values()][0] as Record<string, number | string>;
    expect(run.terminalState).toBe("completed");
    expect(run.totalInputTokens).toBeGreaterThan(0);
    expect(run.totalOutputTokens).toBeGreaterThan(0);
  });
});

describe("validation retry budget", () => {
  it("gives each step its own correction, so an early slip doesn't doom a later one", async () => {
    // The live run spent its single retry on a bad `k` at step 1, leaving none
    // for a different tool's wrong argument name at step 3, which ended the
    // run in tool_failure.
    const { terminal, calls } = await collect([
      { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: "oops" } }] },
      { text: "Retrying.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
      { text: "Searching again.", toolCalls: [{ name: "search_policies", input: { q: "wrong field name" } }] },
      { text: "Retrying.", toolCalls: [{ name: "search_policies", input: { query: "qualifying life event", k: 5 } }] },
      { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
    ]);

    expect(terminal).toMatchObject({ state: "completed" });
    expect(calls.map((c) => c.name).filter((n) => n === "search_policies")).toHaveLength(2);
  });

  it("still gives up when the same step fails validation twice", async () => {
    const { terminal } = await collect([
      { text: "Searching.", toolCalls: [{ name: "search_policies", input: { q: "wrong" } }] },
      { text: "Retrying.", toolCalls: [{ name: "search_policies", input: { query: "ok now", k: 5 } }] },
      { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
    ]);

    expect(terminal).toMatchObject({ state: "completed" });
  });

  it("caps corrections across the run so a confused model can't burn every step", async () => {
    // Distinct wrong arguments each time, so this exercises the validation cap
    // rather than the repeated-call loop guard (which fires on identical calls).
    const guessing = (field: string) => ({
      text: "Guessing.",
      toolCalls: [{ name: "search_policies", input: { [field]: "spouse coverage" } }],
    });
    const { terminal } = await collect([
      guessing("q"),
      guessing("search"),
      guessing("text"),
      guessing("term"),
      { text: JSON.stringify(FINAL) }, // finalize()'s tools-disabled best-effort call
    ]);

    expect(terminal).toMatchObject({ state: "tool_failure" });
  });
});
