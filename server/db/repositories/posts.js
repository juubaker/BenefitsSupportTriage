// server/db/repositories/posts.js
// Data access for the `posts` table. Returns plain objects, not Drizzle rows,
// so the route layer doesn't accidentally leak ORM internals through the API.

import { eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import { posts, categorizations, drafts } from '../schema/index.js';

/**
 * List every post, joined with its most recent categorization and draft.
 * The shape matches what the React UI already consumes from SEED_POSTS.
 */
export async function listPosts() {
  const db = getDb();

  // Latest categorization per post (DISTINCT ON pattern).
  const latestCats = db
    .select({
      postId: categorizations.postId,
      category: categorizations.category,
      confidence: categorizations.confidence,
      reasoning: categorizations.reasoning,
    })
    .from(categorizations)
    .orderBy(categorizations.postId, desc(categorizations.createdAt))
    .as('latest_cats');

  // We can't easily express DISTINCT ON in Drizzle's query builder, so use
  // a window-function CTE via raw SQL. Cleaner for a small payload.
  const rows = await db.execute(sql`
    WITH ranked_cats AS (
      SELECT
        post_id, category, confidence, reasoning,
        ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY created_at DESC) AS rn
      FROM categorizations
    ),
    ranked_drafts AS (
      SELECT
        post_id, content,
        ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY created_at DESC) AS rn
      FROM drafts
    )
    SELECT
      p.id, p.title, p.body, p.status, p.source, p.author,
      p.posted_at, p.answer, p.answered_by, p.seed_category_id,
      c.category, c.confidence, c.reasoning,
      d.content AS draft
    FROM posts p
    LEFT JOIN ranked_cats c ON c.post_id = p.id AND c.rn = 1
    LEFT JOIN ranked_drafts d ON d.post_id = p.id AND d.rn = 1
    ORDER BY p.posted_at DESC
  `);

  return rows.rows.map(rowToPost);
}

export async function getPost(id) {
  const db = getDb();
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  return row ?? null;
}

/**
 * Insert or update a post by id (used by the seeder).
 */
export async function upsertPost(post) {
  const db = getDb();
  await db
    .insert(posts)
    .values({
      id: post.id,
      title: post.title,
      body: post.body,
      status: post.status,
      source: post.source,
      author: post.author,
      postedAt: new Date(post.postedAt),
      answer: post.answer ?? null,
      answeredBy: post.answeredBy ?? null,
      seedCategoryId: post.seedCategoryId ?? null,
    })
    .onConflictDoUpdate({
      target: posts.id,
      set: {
        title: post.title,
        body: post.body,
        status: post.status,
        updatedAt: new Date(),
      },
    });
}

// Map a snake_case raw SQL row to the camelCase shape the UI expects.
function rowToPost(r) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status,
    source: r.source,
    author: r.author,
    postedAt: r.posted_at instanceof Date ? r.posted_at.toISOString() : r.posted_at,
    answer: r.answer,
    answeredBy: r.answered_by,
    seedCategoryId: r.seed_category_id,
    // From join — null if no row matched
    category: r.category,
    confidence: r.confidence === null ? null : Number(r.confidence),
    reasoning: r.reasoning,
    draft: r.draft,
  };
}
