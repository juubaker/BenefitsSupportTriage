/**
 * Postgres/pgvector implementation of the TriageServices port that
 * src/tools.ts declares. This replaces the stubbed services the harness has
 * been running against: the loop's retrieval tools now hit the real
 * policy_chunks / resolved_tickets corpora, and the terminal tools persist.
 *
 * Deliberately depends on a minimal `Queryable` (the shape of a pg Pool or
 * Client) rather than on pg or Drizzle directly, so the whole thing is unit
 * testable with a fake and the agent package keeps no hard driver dependency
 * in its logic path.
 *
 * Columns follow rag/db/schema.ts:
 *   policy_chunks(id, doc_title, section, chunk_text, source_url, plan_type, embedding)
 *   resolved_tickets(id, case_text, category, approved_response, embedding)
 */

import type { TriageServices } from "../tools.js";
import { toVectorLiteral, type Embedder } from "./embeddings.js";

export interface QueryResult<R> {
  rows: R[];
}

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
}

export interface PgTriageServicesOptions {
  db: Queryable;
  embed: Embedder;
  /** Similarity floor: weak matches are worse than no match. */
  minSimilarity?: number;
  /** Hard cap on rows per tool call, independent of what the model asks for. */
  maxK?: number;
}

export interface TicketContext {
  ticketId: string;
  runId?: string;
}

export interface PgTriageServicesFactory {
  /**
   * The terminal tools (triage_ticket, escalate_to_human) need to know which
   * ticket they are finishing, and the tool schemas don't carry it. Bind the
   * services per run, then build the registry per run:
   *
   *   const services = factory.forTicket({ ticketId, runId });
   *   const harness = new AgentHarness({ registry: buildRegistry(services), ... });
   */
  forTicket(ctx: TicketContext): TriageServices;
}

const DEFAULT_MIN_SIMILARITY = 0.45;
const DEFAULT_MAX_K = 10;

/** Stable, model-visible id for a policy chunk. Citations are checked against these. */
export function policyChunkId(row: { id: number | string; chunk_key?: string | null }): string {
  return row.chunk_key ? String(row.chunk_key) : `chunk-${row.id}`;
}

export function resolvedTicketId(row: { id: number | string }): string {
  return `R-${row.id}`;
}

export function createPgTriageServices(opts: PgTriageServicesOptions): PgTriageServicesFactory {
  const { db, embed } = opts;
  const minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const maxK = opts.maxK ?? DEFAULT_MAX_K;
  const clamp = (k: number) => Math.max(1, Math.min(Math.trunc(k) || 1, maxK));

  async function searchPolicies(query: string, k: number) {
    const vector = toVectorLiteral(await embed(query));
    const { rows } = await db.query<{
      id: number;
      chunk_key: string | null;
      doc_title: string;
      section: string | null;
      chunk_text: string;
      similarity: string | number;
    }>(
      `SELECT id, chunk_key, doc_title, section, chunk_text,
              1 - (embedding <=> $1::vector) AS similarity
         FROM policy_chunks
        WHERE 1 - (embedding <=> $1::vector) > $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      [vector, minSimilarity, clamp(k)],
    );
    return rows.map((r) => ({
      chunkId: policyChunkId(r),
      // Section context matters to the model when several chunks share a doc.
      text: r.section ? `${r.doc_title} — ${r.section}\n${r.chunk_text}` : `${r.doc_title}\n${r.chunk_text}`,
      score: Number(r.similarity),
    }));
  }

  async function findSimilarTickets(query: string, k: number) {
    const vector = toVectorLiteral(await embed(query));
    const { rows } = await db.query<{
      id: number;
      category: string;
      approved_response: string;
      similarity: string | number;
    }>(
      `SELECT id, category, approved_response,
              1 - (embedding <=> $1::vector) AS similarity
         FROM resolved_tickets
        WHERE 1 - (embedding <=> $1::vector) > $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      [vector, minSimilarity, clamp(k)],
    );
    return rows.map((r) => ({
      ticketId: resolvedTicketId(r),
      resolution: `[${r.category}] ${r.approved_response}`,
      score: Number(r.similarity),
    }));
  }

  return {
    forTicket(ctx: TicketContext): TriageServices {
      return {
        searchPolicies,
        findSimilarTickets,

        async saveTriage(input: Record<string, unknown>): Promise<void> {
          await db.query(
            `INSERT INTO triage_results
               (ticket_id, run_id, category, priority, summary, citations, escalated, escalation_reason)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, false, NULL)`,
            [
              ctx.ticketId,
              ctx.runId ?? null,
              String(input.category ?? ""),
              String(input.priority ?? ""),
              String(input.summary ?? ""),
              JSON.stringify(Array.isArray(input.citations) ? input.citations : []),
            ],
          );
        },

        async escalate(ticketId: string, reason: string): Promise<void> {
          await db.query(
            `INSERT INTO triage_results
               (ticket_id, run_id, category, priority, summary, citations, escalated, escalation_reason)
             VALUES ($1, $2, NULL, NULL, NULL, '[]'::jsonb, true, $3)`,
            [ticketId || ctx.ticketId, ctx.runId ?? null, reason],
          );
        },
      };
    },
  };
}
