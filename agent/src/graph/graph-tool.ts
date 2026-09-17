import { z } from "zod";
import type { GraphService } from "./graph.js";
import type { ToolDefinition } from "../registry.js";
import { GRAPH_RELATIONS } from "../db/schema/graph.js";

/**
 * traverse_policy_graph (spec §11) — the ONE tool the graph layer adds.
 *
 * Register it on the harness registry ONLY when the graph layer is enabled:
 *
 *   if (process.env.GRAPH_ENABLED === "true") {
 *     registry.register(buildGraphTool(new GraphService(db)));
 *   }
 *
 * The agent then *chooses* whether to use it. Because tool choice is a scored
 * trajectory metric, you get direct evidence of whether it's earning its place —
 * and if it isn't, unregistering it is a one-line rollback.
 *
 * It's a RETRIEVAL tool: metrics.py already counts it in RETRIEVAL_TOOLS, so it
 * satisfies min-retrieval, and its returned chunkIds flow to citations the same
 * way search_policies results do, keeping retrieval-grounding honest.
 */
const graphSchema = z.object({
  seed: z.string().min(2).describe("Concept to start from, e.g. 'qualifying life event'"),
  relations: z
    .array(z.enum(GRAPH_RELATIONS))
    .optional()
    .describe("Optional: restrict to these relationship types"),
  maxDepth: z.number().int().min(1).max(5).default(3),
});

export function buildGraphTool(graph: GraphService): ToolDefinition<typeof graphSchema> {
  return {
    name: "traverse_policy_graph",
    description:
      "Follow typed relationships between benefits concepts to answer multi-hop questions " +
      "(e.g. what a qualifying life event unlocks, what proof a special enrollment requires). " +
      "Start from a concept name; returns relationship paths, each grounded in policy chunk ids " +
      "you can cite. Prefer this over repeated search_policies calls when the question chains " +
      "concepts together. Returns nothing if the seed concept is not in the graph — fall back to search_policies.",
    schema: graphSchema,
    handler: async ({ seed, relations, maxDepth }) => {
      const paths = await graph.traverse(seed, { relations, maxDepth });
      if (paths.length === 0) {
        return {
          data: { paths: [], note: `No graph paths from "${seed}".` },
          summary: `traverse_policy_graph("${seed}") -> no paths`,
        };
      }
      // Compact data for the model: readable path strings + citable chunk ids.
      const rendered = paths.map((p) => ({
        path: p.path.reduce(
          (acc, node, i) => (i === 0 ? node : `${acc} -[${p.relations[i - 1]}]-> ${node}`),
          "",
        ),
        chunkIds: p.chunkIds,
        score: Number(p.score.toFixed(2)),
      }));
      const allChunks = [...new Set(paths.flatMap((p) => p.chunkIds))];
      return {
        data: { paths: rendered },
        summary: `traverse_policy_graph("${seed}") -> ${paths.length} paths, chunks ${allChunks.join(",")}`,
      };
    },
  };
}
