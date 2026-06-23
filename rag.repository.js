// server/db/repositories/rag.js
//
// Repository for the RAG corpora, following the same pattern as posts.js /
// drafts.js: a plain module of named functions, injectable into createApp so
// tests can stub it. Uses pgvector's `<=>` cosine-distance operator via raw
// SQL (simplest and dialect-stable for vector search).
//
// ── ONE THING TO VERIFY ──────────────────────────────────────────────────
// This imports a pg `pool`. Match this to however your OTHER repositories get
// their database handle. If posts.js does `import { pool } from '../pool.js'`,
// keep this as-is. If your repos use a Drizzle `db` (e.g.
// `import { db } from '../client.js'`), tell me and I'll hand you the Drizzle
// version — the SQL is identical, just run through `db.execute(sql\`…\`)`.
// ─────────────────────────────────────────────────────────────────────────
import { pool } from "../pool.js";

export async function searchPolicy(vectorLiteral, { k = 5, minSim = 0.45 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, doc_title, section, chunk_text, source_url,
            1 - (embedding <=> $1::vector) AS similarity
       FROM policy_chunks
      WHERE 1 - (embedding <=> $1::vector) > $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [vectorLiteral, minSim, k]
  );
  return rows.map((r) => ({
    id: r.id,
    docTitle: r.doc_title,
    section: r.section,
    chunkText: r.chunk_text,
    sourceUrl: r.source_url,
    similarity: Number(r.similarity),
  }));
}

export async function searchPrecedents(vectorLiteral, { k = 3, minSim = 0.45 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, case_text, category, approved_response,
            1 - (embedding <=> $1::vector) AS similarity
       FROM resolved_tickets
      WHERE 1 - (embedding <=> $1::vector) > $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [vectorLiteral, minSim, k]
  );
  return rows.map((r) => ({
    id: r.id,
    caseText: r.case_text,
    category: r.category,
    approvedResponse: r.approved_response,
    similarity: Number(r.similarity),
  }));
}

export async function recordRetrievalLog({ caseText, retrieval, citedPolicyIds, abstained }) {
  await pool.query(
    `INSERT INTO retrieval_log
       (case_text, retrieved_policy_ids, retrieved_ticket_ids,
        cited_policy_ids, top_similarity, abstained)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      caseText,
      JSON.stringify(retrieval.policy.map((p) => p.id)),
      JSON.stringify(retrieval.precedents.map((p) => p.id)),
      JSON.stringify(citedPolicyIds),
      retrieval.topSimilarity,
      abstained,
    ]
  );
}
