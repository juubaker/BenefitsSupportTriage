import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentHarness, MemoryRunStore } from "../src/harness.js";
import { ToolRegistry } from "../src/registry.js";
import { FakeProvider, type ScriptedTurn } from "../src/testing/fake-provider.js";
import { buildRegistry, SYSTEM_PROMPT, triageResultSchema } from "../src/tools.js";
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
    // Mirrors the real tool: coercion is part of what these tests exercise.
    schema: z.object({ query: z.string().min(3), k: z.coerce.number().int().default(5) }),
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
    schema: triageResultSchema,
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
    registryFor: () => registry,
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
  it("records the step count too, which step_efficiency scores against", async () => {
    const { registry } = buildTestRegistry();
    const store = new MemoryRunStore();
    const harness = new AgentHarness({
      providers: {
        ollama: new FakeProvider([
          { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
          { text: "Searching again.", toolCalls: [{ name: "search_policies", input: { query: "qualifying life event", k: 5 } }] },
          { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
        ]),
      },
      defaultProvider: "ollama",
      registryFor: () => registry,
      store,
      systemPrompt: "test system prompt",
    });

    for await (const event of harness.run(TICKET)) {
      if (event.type === "terminal") break;
    }

    const run = [...store.runs.values()][0] as Record<string, unknown>;
    expect(run.stepCount).toBe(3);
  });

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
      registryFor: () => registry,
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

describe("narrated tool calls and finalize validation", () => {
  it("names the narrated call in the nudge, and the model can recover from it", async () => {
    // llama3.1 wrote "triage_ticket()" as prose instead of emitting a call.
    const { terminal, calls, provider } = await collect([
      { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
      { text: "Evidence is sufficient.\n\ntriage_ticket()" },
      { text: "Calling it properly.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
    ]);

    const sent = JSON.stringify(provider.requests);
    expect(sent).toContain("You wrote");
    expect(sent).toContain("triage_ticket()");
    expect(sent).toContain("That is not a tool call and nothing ran");
    expect(terminal).toMatchObject({ state: "completed" });
    expect(calls.map((c) => c.name)).toEqual(["search_policies", "triage_ticket"]);
  });

  it("falls back to the generic nudge when the model just wrote prose", async () => {
    const { provider } = await collect([
      { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
      { text: "The spouse may enroll within 31 days." },
      { text: "Right.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
    ]);

    expect(JSON.stringify(provider.requests)).toContain("Do not answer in prose");
  });

  it("coerces the loose JSON a finalized run returns", async () => {
    // The live run finalized with escalated as the string "false".
    const { terminal } = await collect([
      { text: "Prose." },
      { text: "More prose." },
      { text: JSON.stringify({ ...FINAL, escalated: "false", category: " Enrollment " }) },
    ]);

    expect(terminal).toMatchObject({
      state: "no_terminal_tool",
      result: { escalated: false, category: "enrollment" },
    });
  });

  it("discards a finalized result whose category is outside the taxonomy", async () => {
    // The live run finalized with category "benefits", which does not exist.
    const { terminal, events } = await collect([
      { text: "Prose." },
      { text: "More prose." },
      { text: JSON.stringify({ ...FINAL, category: "benefits" }) },
    ]);

    expect(terminal).toMatchObject({ state: "no_terminal_tool" });
    expect((terminal as { result?: unknown }).result).toBeUndefined();
    expect(events.some((e) => e.type === "loop_guard" && e.action === "final_rejected")).toBe(true);
  });
});

describe("cost accounting", () => {
  // FakeProvider reports model "fake-model"; price it like a hosted model in
  // one case and like local inference in the other.
  const PAID = { "fake-model": { inputPerMTok: 3, outputPerMTok: 15 } };
  const FREE = { "fake-model": { inputPerMTok: 0, outputPerMTok: 0 } };

  async function runWith(
    providers: Record<string, FakeProvider>,
    defaultProvider: string,
    pricing: Record<string, { inputPerMTok: number; outputPerMTok: number }>,
  ) {
    const { registry } = buildTestRegistry();
    const store = new MemoryRunStore();
    const harness = new AgentHarness({
      providers: providers as never,
      defaultProvider: defaultProvider as never,
      registryFor: () => registry,
      store,
      systemPrompt: "test system prompt",
      pricing,
    });
    for await (const event of harness.run(TICKET)) {
      if (event.type === "terminal") break;
    }
    return [...store.runs.values()][0] as Record<string, number>;
  }

  it("prices a priced model instead of recording zero", async () => {
    const run = await runWith(
      {
        anthropic: new FakeProvider(
          [
            { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
            { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
          ],
          "anthropic",
        ),
      },
      "anthropic",
      PAID,
    );

    expect(run.totalInputTokens).toBeGreaterThan(0);
    expect(run.totalCostUsd).toBeGreaterThan(0);
  });

  it("records zero for a local model, which genuinely costs nothing", async () => {
    const run = await runWith(
      {
        ollama: new FakeProvider([
          { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
          { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
        ]),
      },
      "ollama",
      FREE,
    );

    expect(run.totalInputTokens).toBeGreaterThan(0);
    expect(run.totalCostUsd).toBe(0);
  });
});

describe("persisted tool arguments", () => {
  it("stores the validated form, so the eval reads ids and not raw JSON text", async () => {
    // llama3.1 sends citations as a JSON string; coercion fixes the call, but
    // the eval reads agent_steps.tool_calls, so persisting the raw text scored
    // a correct answer as a fabricated citation.
    const { store } = await collect([
      { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: "5" } }] },
      { text: "Done.", toolCalls: [{ name: "triage_ticket", input: { ...FINAL, citations: '["chunk-qle-12"]' } }] },
    ]);

    const steps = [...store.steps];
    const triage = steps.flatMap((s) => s.toolCalls).find((c) => c.name === "triage_ticket");
    expect((triage?.args as { citations: string[] }).citations).toEqual(["chunk-qle-12"]);

    const search = steps.flatMap((s) => s.toolCalls).find((c) => c.name === "search_policies");
    expect((search?.args as { k: number }).k).toBe(5);
  });

  it("keeps the raw arguments when validation failed, which is the diagnostic", async () => {
    const { store } = await collect([
      { text: "Guessing.", toolCalls: [{ name: "search_policies", input: { q: "wrong field" } }] },
      { text: "Retrying.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
      { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
    ]);

    const failed = [...store.steps][0].toolCalls[0];
    expect(failed.args).toEqual({ q: "wrong field" });
  });
});

describe("escalation after an ungrounded triage is refused", () => {
  /**
   * The loop-level counterpart to the registry tests: a rejected triage has to
   * lead the model somewhere, and the only honest exit when nothing was
   * retrieved is escalate_to_human. Built against the real buildRegistry so
   * the grounding check under test is the production one.
   */
  async function runOutOfScope(turns: ScriptedTurn[]) {
    const escalations: Array<{ ticketId: string; reason: string }> = [];
    const registry = buildRegistry({
      searchPolicies: async () => [],
      findSimilarTickets: async () => [],
      saveTriage: async () => {
        throw new Error("saveTriage must not be reached for an out-of-scope ticket");
      },
      escalate: async (ticketId: string, reason: string) => {
        escalations.push({ ticketId, reason });
      },
    });
    const store = new MemoryRunStore();
    const harness = new AgentHarness({
      providers: { ollama: new FakeProvider(turns) },
      defaultProvider: "ollama",
      registryFor: () => registry,
      store,
      systemPrompt: SYSTEM_PROMPT,
    });
    const events: AgentEvent[] = [];
    for await (const e of harness.run({
      ticketId: "oos-01",
      subject: "Payroll direct deposit",
      body: "My paycheck went to the wrong bank account. Can you fix my direct deposit?",
    })) {
      events.push(e);
    }
    return { events, terminal: events.find((e) => e.type === "terminal"), escalations };
  }

  it("turns a no-evidence triage attempt into an escalation", async () => {
    const { terminal, escalations } = await runOutOfScope([
      {
        text: "Searching.",
        toolCalls: [{ name: "search_policies", input: { query: "direct deposit wrong account", k: 5 } }],
      },
      {
        text: "Nothing found, but I will categorise it anyway.",
        toolCalls: [
          {
            name: "triage_ticket",
            input: {
              category: "plan_administration",
              priority: "low",
              summary: "Direct deposit correction.",
              citations: [],
              escalated: false,
            },
          },
        ],
      },
      {
        text: "Understood — out of scope.",
        toolCalls: [
          {
            name: "escalate_to_human",
            input: { ticketId: "oos-01", reason: "Payroll request; outside the benefits policy corpus." },
          },
        ],
      },
    ]);

    // "completed" means the loop terminated through a terminal tool; which
    // one it was lives in the tool calls and in triage_results.escalated.
    expect(terminal).toMatchObject({ state: "completed" });
    expect(escalations).toHaveLength(1);
    expect(escalations[0].reason).toContain("Payroll");
  });

  it("lets the agent escalate directly off an empty search, with no refusal needed", async () => {
    const { terminal, escalations } = await runOutOfScope([
      {
        text: "Searching.",
        toolCalls: [{ name: "search_policies", input: { query: "parking permit garage", k: 5 } }],
      },
      {
        text: "The corpus does not cover this.",
        toolCalls: [
          {
            name: "escalate_to_human",
            input: { ticketId: "oos-01", reason: "Facilities request; no policy evidence exists." },
          },
        ],
      },
    ]);

    expect(terminal).toMatchObject({ state: "completed" });
    expect(escalations).toHaveLength(1);
  });
});

describe("provider failover visibility", () => {
  /** Runs with anthropic failing on its first turn and ollama healthy. */
  async function failover(
    err: Error,
    opts: Parameters<AgentHarness["run"]>[1] = {},
  ): Promise<{ events: AgentEvent[]; logs: string[] }> {
    const { registry } = buildTestRegistry();
    const harness = new AgentHarness({
      providers: {
        anthropic: new FakeProvider([{ throwError: err }], "anthropic"),
        ollama: new FakeProvider(
          [
            { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
            { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
          ],
          "ollama",
        ),
      },
      defaultProvider: "anthropic",
      registryFor: () => registry,
      store: new MemoryRunStore(),
      systemPrompt: "test system prompt",
    });

    // The harness logs the provider error deliberately; capture it rather than
    // letting a passing test print a scary line on every run.
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const events: AgentEvent[] = [];
    try {
      for await (const event of harness.run(TICKET, opts)) {
        events.push(event);
        if (event.type === "terminal") break;
      }
    } finally {
      spy.mockRestore();
    }
    return { events, logs };
  }

  it("emits provider_failover carrying the reason, before the fallback starts", async () => {
    // Every live run has dropped from Claude to llama3.1 with no explanation,
    // because the reason went only to a tracing event that is off by default.
    const err = Object.assign(new Error("404 model not found"), { status: 404 });
    const { events } = await failover(err);

    const failoverIdx = events.findIndex((e) => e.type === "provider_failover");
    expect(failoverIdx).toBeGreaterThanOrEqual(0);
    expect(events[failoverIdx]).toMatchObject({
      type: "provider_failover",
      from: "anthropic",
      to: "ollama",
    });
    const reason = (events[failoverIdx] as { reason: string }).reason;
    expect(reason).toContain("404 model not found");
    expect(reason).toContain("status=404");

    // Ordering matters: a client reading the stream in order must see why the
    // provider changed before it sees the new one start.
    const secondStart = events.findIndex(
      (e, i) => i > failoverIdx && e.type === "run_started",
    );
    expect(secondStart).toBeGreaterThan(failoverIdx);
    expect(events[secondStart]).toMatchObject({ provider: "ollama" });
  });

  it("unwraps the cause chain, so a transport failure names itself", async () => {
    const err = new Error("fetch failed");
    (err as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
    const { events } = await failover(err);
    const reason = (events.find((e) => e.type === "provider_failover") as { reason: string }).reason;
    expect(reason).toContain("code=ECONNREFUSED");
    expect(reason).toContain("cause=connect ECONNREFUSED 127.0.0.1:443");
  });

  it("logs the failure server-side, naming the provider and model", async () => {
    const { logs } = await failover(Object.assign(new Error("401 invalid x-api-key"), { status: 401 }));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("provider anthropic (fake-model) failed");
    expect(logs[0]).toContain("status=401");
  });

  it("still logs when the provider is pinned and the error is rethrown", async () => {
    // A pinned provider does not fail over, so the thrown error is all the
    // caller gets — and the harness is the only place that saw the cause.
    const { registry } = buildTestRegistry();
    const harness = new AgentHarness({
      providers: {
        anthropic: new FakeProvider([{ throwError: new Error("529 overloaded") }], "anthropic"),
        ollama: new FakeProvider([], "ollama"),
      },
      defaultProvider: "ollama",
      registryFor: () => registry,
      store: new MemoryRunStore(),
      systemPrompt: "test system prompt",
    });

    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    await expect(async () => {
      for await (const _ of harness.run(TICKET, { provider: "anthropic" })) {
        // drain
      }
    }).rejects.toThrow("529 overloaded");
    spy.mockRestore();

    expect(logs.some((l) => l.includes("provider anthropic") && l.includes("529 overloaded"))).toBe(true);
  });
});
