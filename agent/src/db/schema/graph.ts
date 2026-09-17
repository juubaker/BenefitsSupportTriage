import { index, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Phase 4 graph layer (spec §11) — OPTIONAL, gated on multihop eval results.
 *
 * No Neo4j. Two tables + recursive CTEs give the agent a third retrieval
 * modality it can *choose*. Populated by an offline extraction pass over the
 * existing policy_chunks; queried by the traverse_policy_graph tool.
 *
 * Enable path: generate the migration, run the extractor, register the tool.
 * Disable path: never register the tool — nothing else references these tables,
 * so the rest of the system is unaffected.
 */

/** A benefits-domain entity mentioned in the corpus (plan, QLE, account, rule…). */
export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Canonical lowercased name, e.g. "special enrollment period". */
    name: text("name").notNull(),
    /** Coarse type for filtering: plan | account | event | rule | benefit | role. */
    kind: text("kind").notNull(),
    /** Chunk this entity was first extracted from (provenance). */
    sourceChunkId: text("source_chunk_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("entities_name_idx").on(t.name),
    index("entities_kind_idx").on(t.kind),
  ],
);

/**
 * A directed, typed relationship between two entities, grounded in the chunk
 * that asserts it. `relation` is a small controlled vocabulary so traversal
 * queries and the extraction prompt stay aligned:
 *   triggers | requires | unlocks | excludes | part_of | applies_to
 */
export const edges = pgTable(
  "edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    srcId: uuid("src_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    dstId: uuid("dst_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
    /** The policy chunk that asserts this edge — every traversal result is citable. */
    chunkId: text("chunk_id").notNull(),
    /** Extractor confidence 0..1; traversal can threshold on it. */
    confidence: real("confidence").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("edges_src_idx").on(t.srcId, t.relation),
    index("edges_dst_idx").on(t.dstId),
    index("edges_chunk_idx").on(t.chunkId),
  ],
);

export const GRAPH_RELATIONS = [
  "triggers", // QLE triggers special enrollment period
  "requires", // special enrollment requires proof of event
  "unlocks", // QLE unlocks plan change
  "excludes", // electing X excludes Y
  "part_of", // dental PPO part_of benefits package
  "applies_to", // waiting period applies_to short-term disability
] as const;

export type GraphRelation = (typeof GRAPH_RELATIONS)[number];
export const ENTITY_KINDS = ["plan", "account", "event", "rule", "benefit", "role"] as const;
