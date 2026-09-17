import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Bounded multi-hop traversal over the entities/edges tables via a recursive CTE
 * (spec §11). No graph database — this is the whole "graph engine": ~1 query.
 *
 * Given a seed entity name, walk out to `maxDepth` hops along optionally-filtered
 * relations, returning the paths with the chunk ids that ground every edge. The
 * agent uses those chunk ids as citations, so graph answers are as grounded as
 * vector answers and score the same on the retrieval-grounding metric.
 */

export interface GraphPath {
  /** Ordered entity names from seed to leaf. */
  path: string[];
  /** Ordered relations between them (length = path.length - 1). */
  relations: string[];
  /** Chunk ids grounding each edge on the path (dedup, for citations). */
  chunkIds: string[];
  depth: number;
  /** Product of edge confidences along the path. */
  score: number;
}

export interface TraverseOptions {
  maxDepth?: number; // default 3, hard-capped at 5
  relations?: string[]; // filter to these relation types
  minConfidence?: number; // default 0
  limit?: number; // default 20 paths
}

export class GraphService {
  constructor(private db: NodePgDatabase<Record<string, unknown>>) {}

  async traverse(seedName: string, opts: TraverseOptions = {}): Promise<GraphPath[]> {
    const maxDepth = Math.min(opts.maxDepth ?? 3, 5);
    const minConf = opts.minConfidence ?? 0;
    const limit = opts.limit ?? 20;
    const relFilter = opts.relations?.length ? opts.relations : null;

    // Recursive CTE: seed rows from entities matching the name, then expand along
    // edges. Cycle guard: track visited ids in an array and never revisit.
    const rows = await this.db.execute<{
      names: string[];
      relations: string[];
      chunk_ids: string[];
      depth: number;
      score: number;
    }>(sql`
      WITH RECURSIVE walk AS (
        SELECT
          e.id                              AS current_id,
          ARRAY[e.name]                     AS names,
          ARRAY[]::text[]                   AS relations,
          ARRAY[]::text[]                   AS chunk_ids,
          ARRAY[e.id]                       AS visited,
          0                                 AS depth,
          1.0::real                         AS score
        FROM entities e
        WHERE lower(e.name) = lower(${seedName})

        UNION ALL

        SELECT
          d.id,
          w.names || d.name,
          w.relations || ed.relation,
          w.chunk_ids || ed.chunk_id,
          w.visited || d.id,
          w.depth + 1,
          w.score * ed.confidence
        FROM walk w
        JOIN edges ed   ON ed.src_id = w.current_id
        JOIN entities d ON d.id = ed.dst_id
        WHERE w.depth < ${maxDepth}
          AND ed.confidence >= ${minConf}
          AND NOT d.id = ANY(w.visited)
          AND (${relFilter}::text[] IS NULL OR ed.relation = ANY(${relFilter}::text[]))
      )
      SELECT names, relations, chunk_ids, depth, score
      FROM walk
      WHERE depth > 0
      ORDER BY score DESC, depth ASC
      LIMIT ${limit}
    `);

    // node-postgres returns { rows }; be tolerant of drivers that return the array directly.
    const data =
      (rows as unknown as { rows?: GraphRow[] }).rows ?? (rows as unknown as GraphRow[]);
    return shapeGraphRows(data);
  }
}

export interface GraphRow {
  names: string[];
  relations: string[];
  chunk_ids: string[];
  depth: number;
  score: number;
}

/** Pure projection of raw CTE rows -> GraphPath (unit-testable without a DB). */
export function shapeGraphRows(rows: GraphRow[]): GraphPath[] {
  return rows.map((r) => ({
    path: r.names,
    relations: r.relations,
    chunkIds: [...new Set(r.chunk_ids)],
    depth: r.depth,
    score: r.score,
  }));
}
