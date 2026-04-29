// server/db/repositories/drafts.js

import { eq, desc } from 'drizzle-orm';
import { getDb } from '../client.js';
import { drafts } from '../schema/index.js';

export async function recordDraft({ postId, content, model }) {
  const db = getDb();
  const [row] = await db
    .insert(drafts)
    .values({ postId, content, model })
    .returning();
  return row;
}

export async function getLatestDraft(postId) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(drafts)
    .where(eq(drafts.postId, postId))
    .orderBy(desc(drafts.createdAt))
    .limit(1);
  return row ?? null;
}
