/**
 * Re-export point for your existing Drizzle client + schema.
 *
 * Replace the contents of this file with an import from your existing
 * `rag/db/client.ts` and `rag/db/schema.ts` so this MCP server shares the
 * exact same connection pool and table definitions as your Express API —
 * no drift between the two.
 *
 * Example (adjust paths to match your repo):
 *
 *   export { db } from "../../rag/db/client.js";
 *   export { policyChunks, resolvedTickets } from "../../rag/db/schema.js";
 *
 * Below is a standalone fallback (new pg pool + drizzle instance) in case
 * you want this server runnable independently of the monorepo layout.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { pgTable, serial, text, timestamp, vector } from "drizzle-orm/pg-core";

// Mirrors rag/db/schema.ts — kept as a standalone definition (rather than a
// cross-package import) since this MCP server has its own package.json/deps.
export const policyChunks = pgTable("policy_chunks", {
  id: serial("id").primaryKey(),
  docTitle: text("doc_title").notNull(),
  section: text("section"),
  chunkText: text("chunk_text").notNull(),
  sourceUrl: text("source_url"),
  planType: text("plan_type"),
  embedding: vector("embedding", { dimensions: 768 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Mirrors rag/db/schema.ts.
export const resolvedTickets = pgTable("resolved_tickets", {
  id: serial("id").primaryKey(),
  caseText: text("case_text").notNull(),
  category: text("category").notNull(),
  approvedResponse: text("approved_response").notNull(),
  embedding: vector("embedding", { dimensions: 768 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://triage:triage@localhost:5433/triage";

const client = postgres(connectionString);
export const db = drizzle(client);
