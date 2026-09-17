import { eq } from "drizzle-orm";
import { z } from "zod";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ProviderAdapter } from "../types.js";
import { entities, edges, GRAPH_RELATIONS, ENTITY_KINDS } from "../db/schema/graph.js";

/**
 * Offline graph extraction (spec §11). Runs as a batch job, NOT in the request
 * path: one pass over policy_chunks, extract typed entities + edges per chunk,
 * upsert into the graph tables. Re-run on corpus updates.
 *
 *   npx tsx scripts/extract-graph.ts   (wire buildProviders() + db, then call run())
 *
 * Uses a cheap model (Ollama locally / Haiku on API) — extraction quality
 * matters less than coverage, and this is amortized offline.
 */

const extractionSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().min(2),
      kind: z.enum(ENTITY_KINDS),
    }),
  ),
  edges: z.array(
    z.object({
      src: z.string().min(2),
      dst: z.string().min(2),
      relation: z.enum(GRAPH_RELATIONS),
      confidence: z.number().min(0).max(1).default(0.8),
    }),
  ),
});

const EXTRACTION_PROMPT = `Extract benefits-domain entities and their relationships from the policy text.

Entity kinds: ${ENTITY_KINDS.join(", ")}
Relation types: ${GRAPH_RELATIONS.join(", ")}

Rules:
- Only extract relationships explicitly stated in THIS text.
- Entity names: lowercase, canonical (e.g. "special enrollment period", not "SEP" or "the special enrollment window").
- Prefer fewer, high-confidence edges over many speculative ones.

Respond with ONLY this JSON, no prose, no code fences:
{"entities":[{"name":"...","kind":"..."}],"edges":[{"src":"...","dst":"...","relation":"...","confidence":0.0}]}`;

export interface PolicyChunk {
  chunkId: string;
  text: string;
}

export class GraphExtractor {
  constructor(
    private db: NodePgDatabase<Record<string, unknown>>,
    private provider: ProviderAdapter, // a CHEAP model, not the triage model
  ) {}

  async extractChunk(chunk: PolicyChunk): Promise<z.infer<typeof extractionSchema> | null> {
    const turn = await this.provider.chat({
      system: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: chunk.text }] }],
      tools: [],
      temperature: 0,
      maxTokens: 800,
    });
    try {
      const raw = turn.text.trim().replace(/^```json\s*|\s*```$/g, "");
      return extractionSchema.parse(JSON.parse(raw));
    } catch {
      return null; // skip unparseable chunks; extraction is best-effort
    }
  }

  /** Upsert entities by (name, kind), then edges grounded in the chunk. */
  async persist(chunkId: string, extracted: z.infer<typeof extractionSchema>): Promise<void> {
    const idByKey = new Map<string, string>();
    for (const e of extracted.entities) {
      const name = e.name.toLowerCase();
      const [row] = await this.db
        .insert(entities)
        .values({ name, kind: e.kind, sourceChunkId: chunkId })
        .onConflictDoNothing()
        .returning({ id: entities.id });
      if (row) idByKey.set(`${name}:${e.kind}`, row.id);
    }
    // Resolve endpoints by name (kind-agnostic) for edge creation.
    for (const edge of extracted.edges) {
      const src = await this.resolveId(edge.src.toLowerCase());
      const dst = await this.resolveId(edge.dst.toLowerCase());
      if (!src || !dst) continue;
      await this.db
        .insert(edges)
        .values({
          srcId: src,
          dstId: dst,
          relation: edge.relation,
          chunkId,
          confidence: edge.confidence,
        })
        .onConflictDoNothing();
    }
  }

  private async resolveId(name: string): Promise<string | null> {
    // name is already stored lowercased at insert time.
    const rows = await this.db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.name, name))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async run(chunks: PolicyChunk[], onProgress?: (done: number, total: number) => void): Promise<void> {
    let done = 0;
    for (const chunk of chunks) {
      const extracted = await this.extractChunk(chunk);
      if (extracted) await this.persist(chunk.chunkId, extracted);
      onProgress?.(++done, chunks.length);
    }
  }
}
