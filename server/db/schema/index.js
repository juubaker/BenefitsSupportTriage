// server/db/schema/index.js
// Drizzle schema. Three tables:
//   - posts            : the support posts themselves
//   - categorizations  : audit + cache of LLM categorizations
//   - drafts           : AI-generated draft responses (so they survive refresh)

import {
  pgTable,
  text,
  varchar,
  integer,
  real,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const postStatusEnum = pgEnum('post_status', ['open', 'answered']);

// ---------------------------------------------------------------------------
// posts
// ---------------------------------------------------------------------------

export const posts = pgTable(
  'posts',
  {
    // Use the human-friendly external id (e.g. "CC-7821") as the primary key.
    // Easier to debug, and matches what shows in the UI.
    id: varchar('id', { length: 32 }).primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: postStatusEnum('status').notNull().default('open'),
    source: varchar('source', { length: 64 }).notNull(),
    author: varchar('author', { length: 256 }).notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),

    // Resolved-response fields — null when status = 'open'
    answer: text('answer'),
    answeredBy: varchar('answered_by', { length: 128 }),

    // Optional pre-categorized seed hint. Lets the seeder mark a post as
    // already-classified without paying for an LLM call. The current
    // category is stored in the categorizations table.
    seedCategoryId: varchar('seed_category_id', { length: 32 }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    statusIdx: index('posts_status_idx').on(table.status),
    postedAtIdx: index('posts_posted_at_idx').on(table.postedAt),
  })
);

// ---------------------------------------------------------------------------
// categorizations
// ---------------------------------------------------------------------------
// One row per LLM categorization attempt. Stores the content hash for
// caching — before calling the LLM we look for an existing row with the
// same hash. Also serves as an audit log of how a post has been
// classified over time.

export const categorizations = pgTable(
  'categorizations',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    postId: varchar('post_id', { length: 32 })
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),

    // SHA-256 of (title + body). Lets us cache categorizations across posts
    // with identical content (e.g. duplicate questions).
    contentHash: varchar('content_hash', { length: 64 }).notNull(),

    // Category label, e.g. "Life Events". Server validates against the
    // taxonomy in server/app.js before insert.
    category: varchar('category', { length: 64 }).notNull(),
    confidence: real('confidence').notNull(),
    reasoning: text('reasoning'),

    // Which model produced this? Useful when you change models and want
    // to know if old cached categorizations are still trustworthy.
    model: varchar('model', { length: 64 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    postIdIdx: index('categorizations_post_id_idx').on(table.postId),
    // The content_hash + model combination is what we look up for the cache.
    hashModelIdx: index('categorizations_hash_model_idx').on(table.contentHash, table.model),
  })
);

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------
// AI-generated draft replies. One post can have many drafts (regenerations).

export const drafts = pgTable(
  'drafts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    postId: varchar('post_id', { length: 32 })
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (table) => ({
    postIdIdx: index('drafts_post_id_idx').on(table.postId),
  })
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const postsRelations = relations(posts, ({ many }) => ({
  categorizations: many(categorizations),
  drafts: many(drafts),
}));

export const categorizationsRelations = relations(categorizations, ({ one }) => ({
  post: one(posts, {
    fields: [categorizations.postId],
    references: [posts.id],
  }),
}));

export const draftsRelations = relations(drafts, ({ one }) => ({
  post: one(posts, {
    fields: [drafts.postId],
    references: [posts.id],
  }),
}));
