import {
  pgTable,
  serial,
  text,
  timestamp,
  vector,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";
import { EMBED_DIM } from "../lib/config.js";

/**
 * PRECEDENT CORPUS
 * One row per previously-resolved ticket. We embed the ORIGINAL case text
 * (what the employee asked), because at retrieval time we match an incoming
 * case against past cases that looked similar. The approved_response is the
 * payload we feed back to the model as a worked example.
 */
export const resolvedTickets = pgTable(
  "resolved_tickets",
  {
    id: serial("id").primaryKey(),
    /**
     * Stable, model-visible id, authored in resolved-tickets.json.
     *
     * Citations used to be "R-<serial id>", and the ingest deletes every row
     * before re-inserting, so the sequence advanced each run: the same ticket
     * was R-48, then R-117, then R-135. The row count never changed, which is
     * why it went unnoticed — but every R- id stored in triage_results pointed
     * at a different ticket afterwards, or at nothing. For a reviewer opening
     * an older decision, that is the one thing an audit trail must not do.
     *
     * policy_chunks already had chunk_key for exactly this reason, which is
     * why "chunk-qle-12" survives a re-ingest and grounding_recall can be
     * measured against the golden set at all. This is that, for precedent.
     */
    ticketKey: text("ticket_key"),
    caseText: text("case_text").notNull(),
    category: text("category").notNull(),
    approvedResponse: text("approved_response").notNull(),
    embedding: vector("embedding", { dimensions: EMBED_DIM }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    // HNSW + cosine ops class = fast approximate nearest-neighbor search.
    embeddingIdx: index("resolved_tickets_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops")
    ),
    // Unique so the ingest can upsert on it, which also keeps ids stable.
    ticketKeyIdx: uniqueIndex("resolved_tickets_ticket_key_idx").on(t.ticketKey),
  })
);

/**
 * POLICY CORPUS
 * One row per chunk of a policy/benefits document. This is the FACTUAL
 * grounding source and the thing the reviewer approves citations against.
 * source_url + doc_title + section let you render a real citation in the UI.
 */
export const policyChunks = pgTable(
  "policy_chunks",
  {
    id: serial("id").primaryKey(),
    docTitle: text("doc_title").notNull(),
    section: text("section"),
    chunkText: text("chunk_text").notNull(),
    sourceUrl: text("source_url"),
    // Which plan(s) this chunk applies to. Null means it applies to any plan
    // (e.g. general eligibility rules) rather than one specific plan type.
    planType: text("plan_type"),
    // Stable citation id (e.g. "chunk-qle-12"). Column + partial unique index
    // are created by BenefitsSupportTriage/agent migration 0001.
    chunkKey: text("chunk_key"),
    embedding: vector("embedding", { dimensions: EMBED_DIM }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    embeddingIdx: index("policy_chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops")
    ),
  })
);

/**
 * RETRIEVAL AUDIT LOG (optional but recommended)
 * Persist what was retrieved and what got cited for every drafted case. This
 * feeds your audit story AND becomes raw material for growing the eval set.
 */
export const retrievalLog = pgTable("retrieval_log", {
  id: serial("id").primaryKey(),
  caseText: text("case_text").notNull(),
  retrievedPolicyIds: text("retrieved_policy_ids").notNull(), // JSON array
  retrievedTicketIds: text("retrieved_ticket_ids").notNull(), // JSON array
  citedPolicyIds: text("cited_policy_ids").notNull(), // JSON array
  topSimilarity: real("top_similarity"),
  abstained: text("abstained"), // null, or reason string if we routed to human
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ResolvedTicket = typeof resolvedTickets.$inferSelect;
export type PolicyChunk = typeof policyChunks.$inferSelect;
