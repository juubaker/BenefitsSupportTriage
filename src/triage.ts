/**
 * Extract your existing triage agent-loop logic (currently in your Express
 * route handler) into this shared module, so both the HTTP API and this
 * MCP server call the identical code path — no duplicated business logic,
 * and no risk of the two surfaces drifting apart.
 *
 * This stub sketches the shape: retrieve policy + ticket context, call the
 * Anthropic API to reason over it, return a structured result with
 * retrieval evidence attached.
 */

import { embed } from "./embeddings.js";
import { db, policyChunks, resolvedTickets } from "./db.js";
import { sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

export interface TriageResult {
  category: string;
  priority: "low" | "medium" | "high";
  draft_response: string;
  confidence: number;
  retrieval_evidence: {
    policy_chunks_used: string[];
    similar_tickets_used: string[];
    retrieval_scores: Record<string, number>;
  };
  requires_human_review: boolean;
}

export async function runTriagePipeline(params: {
  ticketText: string;
  employeeContext?: { plan_type?: string; enrollment_status?: string };
}): Promise<TriageResult> {
  const queryEmbedding = await embed(params.ticketText);
  const vectorLiteral = `'[${queryEmbedding.join(",")}]'::vector`;

  const [policyResults, ticketResults] = await Promise.all([
    db
      .select({
        id: policyChunks.id,
        chunkText: policyChunks.chunkText,
        similarity: sql<number>`1 - (${policyChunks.embedding} <=> ${sql.raw(
          vectorLiteral
        )})`,
      })
      .from(policyChunks)
      .orderBy(sql`${policyChunks.embedding} <=> ${sql.raw(vectorLiteral)}`)
      .limit(3),
    db
      .select({
        id: resolvedTickets.id,
        approvedResponse: resolvedTickets.approvedResponse,
        similarity: sql<number>`1 - (${resolvedTickets.embedding} <=> ${sql.raw(
          vectorLiteral
        )})`,
      })
      .from(resolvedTickets)
      .orderBy(sql`${resolvedTickets.embedding} <=> ${sql.raw(vectorLiteral)}`)
      .limit(3),
  ]);

  const contextBlock = [
    "Relevant policy excerpts:",
    ...policyResults.map((p) => `- (${p.id}) ${p.chunkText}`),
    "",
    "Similar past ticket resolutions:",
    ...ticketResults.map((t) => `- (${t.id}) ${t.approvedResponse ?? ""}`),
  ].join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system:
      "You are a benefits support triage assistant. Given a support ticket and retrieved context, classify it and draft a response. Respond ONLY as JSON with keys: category, priority (low|medium|high), draft_response, confidence (0-1).",
    messages: [
      {
        role: "user",
        content: `Ticket: ${params.ticketText}\n\nEmployee context: ${JSON.stringify(
          params.employeeContext ?? {}
        )}\n\nContext:\n${contextBlock}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const parsed = JSON.parse(
    (textBlock?.type === "text" ? textBlock.text : "{}").replace(
      /```json|```/g,
      ""
    )
  );

  const topSimilarity = Math.max(
    ...policyResults.map((p) => p.similarity),
    ...ticketResults.map((t) => t.similarity),
    0
  );

  const retrieval_scores: Record<string, number> = {};
  for (const p of policyResults) retrieval_scores[String(p.id)] = p.similarity;
  for (const t of ticketResults) retrieval_scores[String(t.id)] = t.similarity;

  return {
    category: parsed.category ?? "uncategorized",
    priority: parsed.priority ?? "medium",
    draft_response: parsed.draft_response ?? "",
    confidence: parsed.confidence ?? 0,
    retrieval_evidence: {
      policy_chunks_used: policyResults.map((p) => String(p.id)),
      similar_tickets_used: ticketResults.map((t) => String(t.id)),
      retrieval_scores,
    },
    requires_human_review: topSimilarity < 0.75 || (parsed.confidence ?? 0) < 0.6,
  };
}
