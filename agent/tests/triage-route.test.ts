// Drives real HTTP requests through the SSE route. Every other test calls the
// harness directly, which is how two route-level bugs got through: the run
// being filed as "aborted" when the client breaks on the terminal event, and
// the request-stream "close" listener aborting every run on arrival.
import { describe, expect, it, afterEach, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { AgentHarness, MemoryRunStore } from "../src/harness.js";
import { ToolRegistry } from "../src/registry.js";
import { FakeProvider } from "../src/testing/fake-provider.js";
import { triageRouter } from "../src/routes/triage.js";

const TICKET = {
  ticketId: "T-1",
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

function testRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: "search_policies",
    description: "search",
    schema: z.object({ query: z.string().min(3), k: z.number().int().default(5) }),
    handler: async () => ({
      data: [{ chunkId: "chunk-qle-12", text: "QLE special enrollment...", score: 0.91 }],
      summary: "1 chunk [chunk-qle-12], top score 0.91",
    }),
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
    handler: async () => ({ data: { saved: true }, summary: "saved" }),
  });
  return registry;
}

/** Starts the route on an ephemeral port; returns its URL and the run store. */
async function serve(opts: { delayMs?: number } = {}) {
  const store = new MemoryRunStore();
  const scripted = new FakeProvider([
    { text: "Searching.", toolCalls: [{ name: "search_policies", input: { query: "spouse loss of coverage", k: 5 } }] },
    { text: "Done.", toolCalls: [{ name: "triage_ticket", input: FINAL }] },
  ]);
  // Slow the model down when the test needs a window to disconnect in.
  const provider = opts.delayMs
    ? {
        name: scripted.name,
        model: scripted.model,
        chat: async (...args: Parameters<FakeProvider["chat"]>) => {
          await new Promise((r) => setTimeout(r, opts.delayMs));
          return scripted.chat(...args);
        },
      }
    : scripted;
  const app = express();
  app.use(express.json());
  // One harness for the app, as createAgentRuntime now builds it: the
  // registry is created per run inside the harness.
  app.use(
    triageRouter(
      new AgentHarness({
        providers: { ollama: provider as FakeProvider },
        defaultProvider: "ollama",
        registryFor: () => testRegistry(),
        store,
        systemPrompt: "test system prompt",
      }),
    ),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api/triage`, store, server };
}

let open: Server | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

function parseFrames(text: string) {
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((b) => {
      const [eventLine, dataLine] = b.split("\n");
      return { event: eventLine.replace("event: ", ""), data: JSON.parse(dataLine.replace("data: ", "")) };
    });
}

describe("POST /api/triage over real HTTP", () => {
  it("runs to completion and records the run, rather than aborting on body close", async () => {
    const { url, store, server } = await serve();
    open = server;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TICKET),
    });
    const frames = parseFrames(await res.text());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const terminal = frames.find((f) => f.event === "terminal");
    expect(terminal?.data.state).toBe("completed");

    const run = [...store.runs.values()][0] as Record<string, unknown>;
    expect(run.terminalState).toBe("completed");
    expect(run.totalInputTokens).toBeGreaterThan(0);
    expect(run.totalOutputTokens).toBeGreaterThan(0);
  });

  it("streams the steps the client needs and omits the persisted record", async () => {
    const { url, server } = await serve();
    open = server;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TICKET),
    });
    const events = parseFrames(await res.text()).map((f) => f.event);

    expect(events[0]).toBe("run_started");
    expect(events.at(-1)).toBe("terminal");
    expect(events).not.toContain("step_completed");
  });

  it("rejects a malformed body without starting a run", async () => {
    const { url, store, server } = await serve();
    open = server;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "no ticket id" }),
    });

    expect(res.status).toBe(400);
    expect(store.runs.size).toBe(0);
  });

  it("aborts the run when the client really does disconnect", async () => {
    const { url, store, server } = await serve({ delayMs: 150 });
    open = server;

    const client = new AbortController();
    const req = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TICKET),
      signal: client.signal,
    }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 60));
    client.abort();
    await req.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));

    const run = [...store.runs.values()][0] as Record<string, unknown>;
    expect(run?.terminalState).toBe("aborted");
  });
});

describe("error reporting", () => {
  it("names the cause and its code, not just the wrapper message", async () => {
    // A Drizzle failure arrives as "Failed query: insert into ..." with the
    // real Postgres error — relation missing, connection refused — in `cause`.
    // Reporting only the wrapper is what made this undiagnosable from the
    // client.
    const pgError = Object.assign(new Error('relation "agent_runs" does not exist'), {
      code: "42P01",
    });
    const wrapped = Object.assign(new Error("Failed query: insert into \"agent_runs\"\nparams: x"), {
      cause: pgError,
    });

    // The route logs the failure, which is the point of the change under test.
    // Silenced here so a synthetic error does not print on every suite run and
    // read as a real failure.
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });

    const store = new MemoryRunStore();
    const app = express();
    app.use(express.json());
    app.use(
      triageRouter(() => {
        throw wrapped;
      }),
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    open = server;
    const { port } = server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${port}/api/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TICKET),
    });
    const frames = parseFrames(await res.text());
    const error = frames.find((f) => f.event === "error");

    expect(error?.data.message).toContain("Failed query");
    expect(error?.data.message).not.toContain("params:");
    expect(error?.data.cause).toBe('relation "agent_runs" does not exist');
    expect(error?.data.code).toBe("42P01");
    expect(store.runs.size).toBe(0);
    // The operator-facing log carries it too, which the stream alone did not.
    expect(JSON.stringify(logged)).toContain("does not exist");
    spy.mockRestore();
  });
});
