import { describe, expect, it } from "vitest";
import { shapeGraphRows, type GraphRow, type GraphService } from "../src/graph/graph.js";
import { buildGraphTool } from "../src/graph/graph-tool.js";
import { ToolRegistry } from "../src/registry.js";

// ---- pure result shaping (no DB) ----

describe("shapeGraphRows", () => {
  it("maps CTE rows to paths and dedups grounding chunk ids", () => {
    const rows: GraphRow[] = [
      {
        names: ["qle", "special enrollment period", "plan change"],
        relations: ["triggers", "unlocks"],
        chunk_ids: ["c1", "c2", "c1"], // duplicate c1 across edges
        depth: 2,
        score: 0.72,
      },
    ];
    const [path] = shapeGraphRows(rows);
    expect(path.path).toEqual(["qle", "special enrollment period", "plan change"]);
    expect(path.relations).toEqual(["triggers", "unlocks"]);
    expect(path.chunkIds).toEqual(["c1", "c2"]); // deduped, order preserved
    expect(path.depth).toBe(2);
  });

  it("returns an empty array for no rows", () => {
    expect(shapeGraphRows([])).toEqual([]);
  });
});

// ---- graph tool behavior with a stubbed GraphService ----

function fakeService(traverseImpl: GraphService["traverse"]): GraphService {
  return { traverse: traverseImpl } as unknown as GraphService;
}

describe("traverse_policy_graph tool", () => {
  it("renders readable path strings and aggregates citable chunk ids", async () => {
    const tool = buildGraphTool(
      fakeService(async () => [
        {
          path: ["qualifying life event", "special enrollment period", "proof of event"],
          relations: ["triggers", "requires"],
          chunkIds: ["chunk-qle-12", "chunk-docs-31"],
          depth: 2,
          score: 0.81,
        },
      ]),
    );
    const out = await tool.handler(
      { seed: "qualifying life event", maxDepth: 3 },
      { runId: "r", step: 1 },
    );
    const data = out.data as { paths: Array<{ path: string; chunkIds: string[] }> };
    expect(data.paths[0].path).toBe(
      "qualifying life event -[triggers]-> special enrollment period -[requires]-> proof of event",
    );
    expect(out.summary).toContain("chunk-qle-12,chunk-docs-31");
  });

  it("returns a fall-back note when the seed is not in the graph", async () => {
    const tool = buildGraphTool(fakeService(async () => []));
    const out = await tool.handler({ seed: "unknown thing", maxDepth: 3 }, { runId: "r", step: 1 });
    expect((out.data as { paths: unknown[] }).paths).toEqual([]);
    expect(out.summary).toContain("no paths");
  });

  it("registers as a valid tool and is schema-validated like any other", async () => {
    const registry = new ToolRegistry();
    registry.register(buildGraphTool(fakeService(async () => [])));
    expect(registry.specs().map((s) => s.name)).toContain("traverse_policy_graph");
    // bad args are rejected without throwing (self-correction contract): seed "x" is below min length 2
    const bad = await registry.execute("traverse_policy_graph", { seed: "x" }, { runId: "r", step: 1 });
    expect(bad.ok).toBe(false);
  });
});

// ---- live recursive CTE, only when a real Postgres is provided ----
// pg-mem does not fully support recursive CTEs with array accumulation, so this
// exercises the real query against Postgres in CI (services.postgres) and is
// skipped locally when TEST_DATABASE_URL is unset.

const DB = process.env.TEST_DATABASE_URL;
describe.runIf(DB)("recursive CTE traversal (live Postgres)", () => {
  it("walks multi-hop, guards cycles, bounds depth, collects grounding chunks", async () => {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const { GraphService } = await import("../src/graph/graph.js");
    const pool = new Pool({ connectionString: DB });
    const db = drizzle(pool);

    await pool.query(`
      DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS entities;
      CREATE TABLE entities(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, kind text, source_chunk_id text, created_at timestamptz default now());
      CREATE TABLE edges(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), src_id uuid, dst_id uuid, relation text, chunk_id text, confidence real, created_at timestamptz default now());
      WITH e AS (
        INSERT INTO entities(name,kind,source_chunk_id) VALUES
          ('qle','event','c1'),('sep','event','c1'),('plan change','rule','c2'),('proof','rule','c3')
        RETURNING id, name)
      INSERT INTO edges(src_id,dst_id,relation,chunk_id,confidence)
      SELECT a.id,b.id,'triggers','c1',0.9 FROM e a, e b WHERE a.name='qle' AND b.name='sep'
      UNION ALL SELECT a.id,b.id,'unlocks','c2',0.8 FROM e a, e b WHERE a.name='sep' AND b.name='plan change'
      UNION ALL SELECT a.id,b.id,'requires','c3',0.95 FROM e a, e b WHERE a.name='sep' AND b.name='proof'
      UNION ALL SELECT a.id,b.id,'applies_to','c4',0.5 FROM e a, e b WHERE a.name='proof' AND b.name='qle';
    `);

    const svc = new GraphService(db);
    const paths = await svc.traverse("qle", { maxDepth: 3 });

    // At least the two-hop paths qle->sep->plan change and qle->sep->proof exist.
    const rendered = paths.map((p) => p.path.join(">"));
    expect(rendered).toContain("qle>sep>plan change");
    expect(rendered).toContain("qle>sep>proof");
    // Cycle guard: proof->qle edge must not produce a path revisiting qle.
    expect(rendered.every((r) => (r.match(/qle/g) ?? []).length === 1)).toBe(true);
    // Grounding chunks are collected along the path.
    const twoHop = paths.find((p) => p.path.join(">") === "qle>sep>proof");
    expect(twoHop?.chunkIds).toEqual(expect.arrayContaining(["c1", "c3"]));

    await pool.end();
  });
});
