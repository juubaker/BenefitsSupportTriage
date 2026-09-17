import { context, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AgentHarness, MemoryRunStore } from "../src/harness.js";
import { ToolRegistry } from "../src/registry.js";
import { AgentTracing } from "../src/tracing.js";
import { FakeProvider } from "../src/testing/fake-provider.js";
import { z } from "zod";
import type { TriageRequest } from "../src/types.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
provider.register();
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

afterAll(() => provider.shutdown());
beforeEach(() => exporter.reset());

const TICKET: TriageRequest = { ticketId: "T-1", subject: "s", body: "b" };
const FINAL = {
  category: "enrollment",
  priority: "high",
  summary: "done",
  citations: ["c1"],
  escalated: false,
};

function buildHarness(store = new MemoryRunStore()) {
  const registry = new ToolRegistry();
  registry.register({
    name: "search_policies",
    description: "search",
    schema: z.object({ query: z.string() }),
    handler: async () => ({ data: [{ chunkId: "c1" }], summary: "1 chunk" }),
  });
  registry.register({
    name: "triage_ticket",
    description: "final",
    schema: z.object({
      category: z.string(),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      summary: z.string(),
      citations: z.array(z.string()),
      escalated: z.boolean(),
    }),
    terminal: true,
    handler: async () => ({ data: { saved: true }, summary: "saved" }),
  });
  const fake = new FakeProvider([
    { text: "searching", toolCalls: [{ name: "search_policies", input: { query: "qle" } }] },
    { toolCalls: [{ name: "triage_ticket", input: FINAL }] },
  ]);
  return {
    store,
    harness: new AgentHarness({
      providers: { ollama: fake },
      defaultProvider: "ollama",
      registry,
      store,
      systemPrompt: "sys",
      tracing: new AgentTracing(trace.getTracer("test")),
    }),
  };
}

async function drain(harness: AgentHarness) {
  for await (const _ of harness.run(TICKET)) {
    // consume
  }
}

const byName = (spans: ReadableSpan[], name: string) =>
  spans.filter((s) => s.name.startsWith(name));

describe("agent tracing", () => {
  it("emits the spec §7 span tree with correct parenting", async () => {
    const { harness } = buildHarness();
    await drain(harness);
    const spans = exporter.getFinishedSpans();

    const run = byName(spans, "agent.run")[0];
    const steps = byName(spans, "agent.step");
    const chats = byName(spans, "gen_ai.chat");
    const tools = byName(spans, "agent.tool.");

    expect(run).toBeDefined();
    expect(steps).toHaveLength(2);
    expect(chats).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "agent.tool.search_policies",
      "agent.tool.triage_ticket",
    ]);

    for (const s of steps) expect(s.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    const stepIds = new Set(steps.map((s) => s.spanContext().spanId));
    for (const s of [...chats, ...tools]) {
      expect(stepIds.has(s.parentSpanContext?.spanId ?? "")).toBe(true);
    }
    // everything shares one trace
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it("records GenAI semconv usage attributes and run rollups", async () => {
    const { harness } = buildHarness();
    await drain(harness);
    const spans = exporter.getFinishedSpans();

    const chat = byName(spans, "gen_ai.chat")[0];
    expect(chat.attributes["gen_ai.system"]).toBe("ollama");
    expect(chat.attributes["gen_ai.usage.input_tokens"]).toBe(500);
    expect(chat.attributes["gen_ai.usage.output_tokens"]).toBe(100);

    const run = byName(spans, "agent.run")[0];
    expect(run.attributes["agent.terminal_state"]).toBe("completed");
    expect(run.attributes["agent.step_count"]).toBe(2);
    expect(run.attributes["gen_ai.usage.input_tokens"]).toBe(1000);

    const tool = byName(spans, "agent.tool.search_policies")[0];
    expect(tool.attributes["agent.tool.ok"]).toBe(true);
    expect(String(tool.attributes["agent.tool.args_hash"])).toHaveLength(16);
  });

  it("persists trace_id on the run and span_id on every step", async () => {
    const { harness, store } = buildHarness();
    await drain(harness);
    const spans = exporter.getFinishedSpans();
    const run = byName(spans, "agent.run")[0];

    expect([...store.runs.values()][0].traceId).toBe(run.spanContext().traceId);
    const stepSpanIds = byName(spans, "agent.step").map((s) => s.spanContext().spanId);
    for (const step of store.steps) {
      expect(step.spanId).toBeDefined();
      expect(stepSpanIds).toContain(step.spanId!);
    }
  });

  it("parents the whole run under an inbound W3C traceparent (sidecar linkage)", async () => {
    const { harness, store } = buildHarness();
    const inboundTraceId = "0af7651916cd43dd8448eb211c80319c";
    const traceparent = `00-${inboundTraceId}-b7ad6b7169203331-01`;

    for await (const _ of harness.run(TICKET, { traceparent })) {
      // consume
    }
    const run = byName(exporter.getFinishedSpans(), "agent.run")[0];
    expect(run.spanContext().traceId).toBe(inboundTraceId);
    expect(run.parentSpanContext?.spanId).toBe("b7ad6b7169203331");
    expect([...store.runs.values()][0].traceId).toBe(inboundTraceId);
  });
});
