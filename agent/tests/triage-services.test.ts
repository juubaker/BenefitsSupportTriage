import { describe, it, expect } from "vitest";
import {
  createPgTriageServices,
  type Queryable,
  type QueryResult,
} from "../src/services/pg-triage-services.js";
import { createOllamaEmbedder, toVectorLiteral } from "../src/services/embeddings.js";
import { buildRegistry } from "../src/tools.js";

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
