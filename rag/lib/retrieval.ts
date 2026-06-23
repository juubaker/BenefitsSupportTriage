import { cosineDistance, desc, gt, sql } from "drizzle-orm";
import { db } from "../db/client";
import { policyChunks, resolvedTickets } from "../db/schema";
import { embed } from "./embeddings";
import { PRECEDENT_K, POLICY_K, MIN_SIMILARITY } from "./config";

export interface PolicyHit {
  id: number;
  docTitle: string;
  section: string | null;
  chunkText: string;
  sourceUrl: string | null;
  similarity: number;
}

export interface PrecedentHit {
  id: number;
  caseText: string;
  category: string;
  approvedResponse: string;
  similarity: number;
}

export interface RetrievalResult {
  policy: PolicyHit[];
  precedents: PrecedentHit[];
  topSimilarity: number; // best policy match; drives abstention upstream
}

/**
 * Retrieve grounding for an incoming case from BOTH corpora in parallel.
 *
 * Cosine distance in pgvector is `<=>`; similarity = 1 - distance. We filter
 * on a minimum similarity so weak matches don't get injected as if they were
 * relevant (better to retrieve nothing than to ground on noise).
 */
export async function retrieve(caseText: string): Promise<RetrievalResult> {
  const q = await embed(caseText);

  const policySim = sql<number>`1 - (${cosineDistance(policyChunks.embedding, q)})`;
  const ticketSim = sql<number>`1 - (${cosineDistance(resolvedTickets.embedding, q)})`;

  const [policy, precedents] = await Promise.all([
    db
      .select({
        id: policyChunks.id,
        docTitle: policyChunks.docTitle,
        section: policyChunks.section,
        chunkText: policyChunks.chunkText,
        sourceUrl: policyChunks.sourceUrl,
        similarity: policySim,
      })
      .from(policyChunks)
      .where(gt(policySim, MIN_SIMILARITY))
      .orderBy(desc(policySim))
      .limit(POLICY_K),

    db
      .select({
        id: resolvedTickets.id,
        caseText: resolvedTickets.caseText,
        category: resolvedTickets.category,
        approvedResponse: resolvedTickets.approvedResponse,
        similarity: ticketSim,
      })
      .from(resolvedTickets)
      .where(gt(ticketSim, MIN_SIMILARITY))
      .orderBy(desc(ticketSim))
      .limit(PRECEDENT_K),
  ]);

  const topSimilarity = policy.length ? policy[0].similarity : 0;
  return { policy, precedents, topSimilarity };
}
