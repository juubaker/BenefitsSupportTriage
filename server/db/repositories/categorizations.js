// server/db/repositories/categorizations.js
// Read/write categorization records. Doubles as the cache layer: before
// hitting the LLM, look up by content hash + model.

import { createHash } from 'node:crypto';
import { and, eq, desc } from 'drizzle-orm';
import { getDb } from '../client.js';
import { categorizations } from '../schema/index.js';

export function hashContent(title, body) {
  return createHash('sha256').update(`${title}\n\n${body}`).digest('hex');
}

/**
 * Look up the most recent cached categorization for this content + model.
 * Returns null if there's no cache hit.
 */
export async function findCached({ contentHash, model }) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(categorizations)
    .where(and(eq(categorizations.contentHash, contentHash), eq(categorizations.model, model)))
    .orderBy(desc(categorizations.createdAt))
    .limit(1);
  return row ?? null;
}

export async function recordCategorization({
  postId,
  contentHash,
  category,
  confidence,
  reasoning,
  model,
}) {
  const db = getDb();
  const [row] = await db
    .insert(categorizations)
    .values({
      postId,
      contentHash,
      category,
      confidence,
      reasoning: reasoning ?? null,
      model,
    })
    .returning();
  return row;
}

export async function listForPost(postId) {
  const db = getDb();
  return db
    .select()
    .from(categorizations)
    .where(eq(categorizations.postId, postId))
    .orderBy(desc(categorizations.createdAt));
}
