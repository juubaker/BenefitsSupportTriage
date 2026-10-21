import { describe, it, expect } from "vitest";
import {
  createPgTriageServices,
  type Queryable,
  type QueryResult,
} from "../src/services/pg-triage-services.js";
import { createOllamaEmbedder, toVectorLiteral } from "../src/services/embeddings.js";
import {
  buildRegistry,
  CATEGORY_GUIDANCE,
  TRIAGE_CATEGORIES,
  TRIAGE_PRIORITIES,
} from "../src/tools.js";

/** Records every statement and returns canned rows, so no Postgres is needed. */
function fakeDb(rowsByCall: Array<Array<Record<string, unknown>>> = []): Queryable & {
  calls: Array<{ text: string; params: unknown[] }>;
} {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  let cursor = 0;
  return {
    calls,
    async query<R>(text: string, params: unknown[] = []): Promise<QueryResult<R>> {
      calls.push({ text, params });
      return { rows: (rowsByCall[cursor++] ?? []) as R[] };
    },
  };
}

const embed = async (text: string) => [text.length / 100, 0.2, 0.3];

describe("createPgTriageServices", () => {
  it("embeds the query and passes a pgvector literal, floor and limit", async () => {
    const db = fakeDb([[]]);
    const services = createPgTriageServices({ db, embed, minSimilarity: 0.5 }).forTicket({
      ticketId: "T-1",
    });

    await services.searchPolicies("qualifying life event", 3);

    expect(db.calls).toHaveLength(1);
    const [vector, floor, limit] = db.calls[0].params;
    expect(vector).toBe(toVectorLiteral(await embed("qualifying life event")));
    expect(floor).toBe(0.5);
    expect(limit).toBe(3);
    expect(db.calls[0].text).toContain("FROM policy_chunks");
  });

  it("clamps k to the configured maximum regardless of what the model asks", async () => {
    const db = fakeDb([[], []]);
    const services = createPgTriageServices({ db, embed, maxK: 5 }).forTicket({ ticketId: "T-1" });

    await services.searchPolicies("anything", 50);
    await services.findSimilarTickets("anything", 0);

    expect(db.calls[0].params[2]).toBe(5);
    expect(db.calls[1].params[2]).toBe(1);
  });

  it("maps policy rows to citable ids, preferring chunk_key over the serial id", async () => {
    const db = fakeDb([
      [
        {
          id: 12,
          chunk_key: "chunk-qle-12",
          doc_title: "Benefits Guide",
          section: "Qualifying Life Events",
          chunk_text: "A QLE opens a 31-day window.",
          similarity: "0.82",
        },
        {
          id: 31,
          chunk_key: null,
          doc_title: "Benefits Guide",
          section: null,
          chunk_text: "Proof of the event is required.",
          similarity: 0.61,
        },
      ],
    ]);
    const services = createPgTriageServices({ db, embed }).forTicket({ ticketId: "T-1" });

    const hits = await services.searchPolicies("spouse lost coverage", 5);

    expect(hits[0].chunkId).toBe("chunk-qle-12");
    expect(hits[0].text).toContain("Qualifying Life Events");
    expect(hits[0].score).toBeCloseTo(0.82);
    expect(hits[1].chunkId).toBe("chunk-31");
    expect(hits[1].text).not.toContain("—");
  });

  it("maps resolved tickets to R-prefixed ids with the category inlined", async () => {
    const db = fakeDb([
      [{ id: 2201, category: "enrollment", approved_response: "Added spouse within 31 days.", similarity: 0.77 }],
    ]);
    const services = createPgTriageServices({ db, embed }).forTicket({ ticketId: "T-1" });

    const hits = await services.findSimilarTickets("spouse laid off", 3);

    expect(hits[0]).toEqual({
      ticketId: "R-2201",
      resolution: "[enrollment] Added spouse within 31 days.",
      score: 0.77,
    });
  });

  it("persists a triage decision against the bound ticket and run", async () => {
    const db = fakeDb([[]]);
    const services = createPgTriageServices({ db, embed }).forTicket({
      ticketId: "T-42",
      runId: "11111111-1111-4111-8111-111111111111",
    });

    await services.saveTriage({
      category: "enrollment",
      priority: "high",
      summary: "QLE special enrollment.",
      citations: ["chunk-qle-12"],
    });

    const { text, params } = db.calls[0];
    expect(text).toContain("INSERT INTO triage_results");
    expect(params[0]).toBe("T-42");
    expect(params[1]).toBe("11111111-1111-4111-8111-111111111111");
    expect(params[2]).toBe("enrollment");
    expect(params[3]).toBe("high");
    expect(JSON.parse(String(params[5]))).toEqual(["chunk-qle-12"]);
  });

  it("records an escalation with its reason", async () => {
    const db = fakeDb([[]]);
    const services = createPgTriageServices({ db, embed }).forTicket({ ticketId: "T-42" });

    await services.escalate("T-42", "Requires account-specific payroll data.");

    expect(db.calls[0].params[0]).toBe("T-42");
    expect(db.calls[0].params[2]).toBe("Requires account-specific payroll data.");
  });

  it("satisfies the TriageServices port the tool registry expects", async () => {
    const db = fakeDb([[], []]);
    const services = createPgTriageServices({ db, embed }).forTicket({ ticketId: "T-1" });

    const registry = buildRegistry(services);

    expect(registry.specs().map((s) => s.name).sort()).toEqual([
      "escalate_to_human",
      "find_similar_tickets",
      "search_policies",
      "triage_ticket",
    ]);
  });
});

describe("createOllamaEmbedder", () => {
  it("rejects a vector whose width does not match the corpus", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })) as unknown as typeof fetch;
    const embedder = createOllamaEmbedder({ fetchImpl, dimensions: 768 });

    await expect(embedder("hello")).rejects.toThrow(/does not match corpus width 768/);
  });

  it("surfaces a failed embed call with its status", async () => {
    const fetchImpl = (async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
    const embedder = createOllamaEmbedder({ fetchImpl });

    await expect(embedder("hello")).rejects.toThrow(/Ollama embed failed \(404\)/);
  });
});

describe("buildRegistry citation enforcement", () => {
  const services = (hits: string[] = ["chunk-qle-12"]) => ({
    searchPolicies: async () => hits.map((id, i) => ({ chunkId: id, text: "…", score: 0.8 - i / 100 })),
    findSimilarTickets: async () => [{ ticketId: "R-2201", resolution: "…", score: 0.77 }],
    saveTriage: async () => {},
    escalate: async () => {},
  });
  const ctx = { runId: "run-1", step: 1 };
  const decision = (citations: string[]) => ({
    category: "enrollment",
    priority: "high",
    summary: "QLE special enrollment.",
    citations,
    escalated: false,
  });

  it("rejects a citation no tool call in this run returned", async () => {
    const registry = buildRegistry(services());
    await registry.execute("search_policies", { query: "spouse lost coverage", k: 5 }, ctx);

    const res = await registry.execute("triage_ticket", decision(["chunk-4", "chunk-qle-12"]), ctx);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("validation");
    expect(res.error).toContain("chunk-4");
    expect(res.error).not.toContain("chunk-qle-12, chunk-4");
  });

  it("accepts citations that were retrieved, across both corpora", async () => {
    const registry = buildRegistry(services(["chunk-qle-12", "chunk-cobra-04"]));
    await registry.execute("search_policies", { query: "spouse lost coverage", k: 5 }, ctx);
    await registry.execute("find_similar_tickets", { description: "spouse laid off", k: 3 }, ctx);

    const res = await registry.execute(
      "triage_ticket",
      decision(["chunk-qle-12", "chunk-cobra-04", "R-2201"]),
      ctx,
    );

    expect(res.ok).toBe(true);
  });

  it("does not let one run's retrieved ids vouch for another run's citations", async () => {
    const registry = buildRegistry(services());
    await registry.execute("search_policies", { query: "spouse lost coverage", k: 5 }, ctx);

    const res = await registry.execute("triage_ticket", decision(["chunk-qle-12"]), {
      runId: "run-2",
      step: 1,
    });

    expect(res.ok).toBe(false);
  });

  it("rejects a category outside the taxonomy before the handler runs", async () => {
    const registry = buildRegistry(services());

    const res = await registry.execute(
      "triage_ticket",
      { ...decision([]), category: "benefits-enrollment" },
      ctx,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("validation");
  });
});

describe("tool schemas against what smaller models actually send", () => {
  const services = {
    searchPolicies: async () => [{ chunkId: "chunk-qle-12", text: "…", score: 0.8 }],
    findSimilarTickets: async () => [{ ticketId: "R-2201", resolution: "…", score: 0.77 }],
    saveTriage: async () => {},
    escalate: async () => {},
  };
  const ctx = { runId: "run-1", step: 1 };

  it('accepts k as a string, which llama3.1 sends ("10" not 10)', async () => {
    const res = await buildRegistry(services).execute(
      "search_policies",
      { query: "spouse added mid-year", k: "10" },
      ctx,
    );

    expect(res.ok).toBe(true);
  });

  it("accepts query on find_similar_tickets, not just description", async () => {
    const registry = buildRegistry(services);

    const withQuery = await registry.execute(
      "find_similar_tickets",
      { query: "spouse added mid-year", k: 3 },
      ctx,
    );
    const withDescription = await registry.execute(
      "find_similar_tickets",
      { description: "spouse added mid-year", k: 3 },
      ctx,
    );

    expect(withQuery.ok).toBe(true);
    expect(withDescription.ok).toBe(true);
  });

  it("still rejects a find_similar_tickets call with neither", async () => {
    const res = await buildRegistry(services).execute("find_similar_tickets", { k: 3 }, ctx);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe("validation");
  });

  it("exposes every tool as JSON schema for the model", () => {
    // A transform in a tool schema throws here rather than at registration,
    // so this guards the whole registry, not just the tool under test.
    expect(() => buildRegistry(services).specs()).not.toThrow();
  });
});

describe("triage_ticket accepts what the model sent at step 4 of the live run", () => {
  const services = {
    searchPolicies: async () => [{ chunkId: "chunk-qle-12", text: "…", score: 0.69 }],
    findSimilarTickets: async () => [],
    saveTriage: async () => {},
    escalate: async () => {},
  };
  const ctx = { runId: "run-1", step: 1 };
  const base = {
    category: "eligibility",
    priority: "medium",
    summary: "Spouse can be added mid-year after job loss.",
  };

  async function submit(extra: Record<string, unknown>) {
    const registry = buildRegistry(services);
    await registry.execute("search_policies", { query: "spouse job loss", k: 5 }, ctx);
    return registry.execute("triage_ticket", { ...base, ...extra }, ctx);
  }

  it('accepts citations as a JSON-encoded array string', async () => {
    const res = await submit({ citations: '["chunk-qle-12"]', escalated: false });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.validatedArgs).toMatchObject({ citations: ["chunk-qle-12"] });
  });

  it('accepts escalated as the string "False"', async () => {
    const res = await submit({ citations: ["chunk-qle-12"], escalated: "False" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.validatedArgs).toMatchObject({ escalated: false });
  });

  it("accepts a comma-separated citation list", async () => {
    const res = await submit({ citations: "chunk-qle-12", escalated: false });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.validatedArgs).toMatchObject({ citations: ["chunk-qle-12"] });
  });

  it("still enforces grounding on coerced citations", async () => {
    const res = await submit({ citations: '["chunk-4"]', escalated: false });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("chunk-4");
  });

  it('still rejects escalated: "true" on the non-escalation tool', async () => {
    const res = await submit({ citations: ["chunk-qle-12"], escalated: "true" });

    expect(res.ok).toBe(false);
  });
});

describe("taxonomy guidance in the tool schema", () => {
  const services = {
    searchPolicies: async () => [],
    findSimilarTickets: async () => [],
    saveTriage: async () => {},
    escalate: async () => {},
  };
  const spec = () =>
    buildRegistry(services)
      .specs()
      .find((s) => s.name === "triage_ticket") as unknown as {
      inputSchema: { properties: Record<string, { description?: string }> };
    };

  it("sends a definition for every category the enum accepts", () => {
    const description = spec().inputSchema.properties.category.description ?? "";

    for (const category of TRIAGE_CATEGORIES) {
      expect(description).toContain(`${category} — `);
    }
  });

  it("states the enrollment/eligibility boundary that the live runs got wrong", () => {
    const description = spec().inputSchema.properties.category.description ?? "";

    expect(description).toContain("add my spouse mid-year");
    expect(description).toMatch(/enrollment is an ACTION/);
    expect(description).toMatch(/eligibility is whether someone QUALIFIES/);
  });

  it("gives each priority level a rule rather than a bare word", () => {
    const description = spec().inputSchema.properties.priority.description ?? "";

    for (const level of TRIAGE_PRIORITIES) {
      expect(description).toContain(`${level}:`);
    }
    expect(description).toContain("31-day window");
  });

  it("keeps the guidance and the enum in step", () => {
    expect(Object.keys(CATEGORY_GUIDANCE).sort()).toEqual([...TRIAGE_CATEGORIES].sort());
  });
});
