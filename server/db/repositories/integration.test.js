// @vitest-environment node
//
// Integration tests for the repository layer. Hits a real Postgres.
// Skipped automatically unless TEST_DATABASE_URL is set in the environment.
//
// To run locally:
//   docker compose up -d postgres
//   TEST_DATABASE_URL=postgresql://triage:triage@localhost:5433/triage_test \
//     npm run db:migrate
//   TEST_DATABASE_URL=postgresql://triage:triage@localhost:5433/triage_test \
//     npx vitest run server/db/repositories/integration.test.js
//
// Use a SEPARATE database for tests — the suite truncates tables between runs.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('repository integration (live db)', () => {
  let postsRepo;
  let catsRepo;
  let draftsRepo;
  let getDb;
  let closeDb;

  beforeAll(async () => {
    // Point the client at the test database before importing it
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    ({ getDb, closeDb } = await import('../client.js'));
    postsRepo = await import('./posts.js');
    catsRepo = await import('./categorizations.js');
    draftsRepo = await import('./drafts.js');
  });

  afterAll(async () => {
    if (closeDb) await closeDb();
  });

  beforeEach(async () => {
    // Truncate tables in the right order to respect FKs
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE drafts, categorizations, posts RESTART IDENTITY CASCADE`);
  });

  it('upserts a post and reads it back via listPosts', async () => {
    await postsRepo.upsertPost({
      id: 'TEST-1',
      title: 'Test',
      body: 'Body',
      status: 'open',
      source: 'IntegrationTest',
      author: 'test@example.com',
      postedAt: '2026-04-01',
    });

    const rows = await postsRepo.listPosts();
    const found = rows.find((p) => p.id === 'TEST-1');
    expect(found).toBeDefined();
    expect(found.title).toBe('Test');
    expect(found.category).toBeNull();
  });

  it('records a categorization and exposes it on listPosts via the latest-cat join', async () => {
    await postsRepo.upsertPost({
      id: 'TEST-2',
      title: 'Open Enrollment Q',
      body: 'OE not visible',
      status: 'open',
      source: 'IntegrationTest',
      author: 'a@b.com',
      postedAt: '2026-04-01',
    });

    const hash = catsRepo.hashContent('Open Enrollment Q', 'OE not visible');
    await catsRepo.recordCategorization({
      postId: 'TEST-2',
      contentHash: hash,
      category: 'Open Enrollment',
      confidence: 0.91,
      reasoning: 'integration',
      model: 'test-model',
    });

    const rows = await postsRepo.listPosts();
    const found = rows.find((p) => p.id === 'TEST-2');
    expect(found.category).toBe('Open Enrollment');
    expect(found.confidence).toBeCloseTo(0.91, 2);
  });

  it('cache lookup by content hash + model returns the most recent row', async () => {
    await postsRepo.upsertPost({
      id: 'TEST-3',
      title: 'Cache test',
      body: 'Body',
      status: 'open',
      source: 'IntegrationTest',
      author: 'a@b.com',
      postedAt: '2026-04-01',
    });

    const hash = catsRepo.hashContent('Cache test', 'Body');
    await catsRepo.recordCategorization({
      postId: 'TEST-3',
      contentHash: hash,
      category: 'Life Events',
      confidence: 0.5,
      reasoning: 'first',
      model: 'm1',
    });
    await catsRepo.recordCategorization({
      postId: 'TEST-3',
      contentHash: hash,
      category: 'Life Events',
      confidence: 0.9,
      reasoning: 'second',
      model: 'm1',
    });

    const cached = await catsRepo.findCached({ contentHash: hash, model: 'm1' });
    expect(cached.reasoning).toBe('second');
    expect(cached.confidence).toBeCloseTo(0.9, 2);
  });

  it('cache misses on a different model', async () => {
    await postsRepo.upsertPost({
      id: 'TEST-4',
      title: 'X',
      body: 'Y',
      status: 'open',
      source: 'IntegrationTest',
      author: 'a@b.com',
      postedAt: '2026-04-01',
    });
    const hash = catsRepo.hashContent('X', 'Y');
    await catsRepo.recordCategorization({
      postId: 'TEST-4',
      contentHash: hash,
      category: 'COBRA',
      confidence: 0.7,
      reasoning: 'r',
      model: 'old-model',
    });
    const cached = await catsRepo.findCached({ contentHash: hash, model: 'new-model' });
    expect(cached).toBeNull();
  });

  it('records a draft and exposes it as the latest', async () => {
    await postsRepo.upsertPost({
      id: 'TEST-5',
      title: 'Draft test',
      body: 'Body',
      status: 'open',
      source: 'IntegrationTest',
      author: 'a@b.com',
      postedAt: '2026-04-01',
    });
    await draftsRepo.recordDraft({ postId: 'TEST-5', content: 'first', model: 'm' });
    await draftsRepo.recordDraft({ postId: 'TEST-5', content: 'second', model: 'm' });

    const latest = await draftsRepo.getLatestDraft('TEST-5');
    expect(latest.content).toBe('second');

    const rows = await postsRepo.listPosts();
    const found = rows.find((p) => p.id === 'TEST-5');
    expect(found.draft).toBe('second');
  });

  it('cascading delete: deleting a post removes its categorizations and drafts', async () => {
    await postsRepo.upsertPost({
      id: 'TEST-6',
      title: 'Cascade',
      body: 'Body',
      status: 'open',
      source: 'IntegrationTest',
      author: 'a@b.com',
      postedAt: '2026-04-01',
    });
    const hash = catsRepo.hashContent('Cascade', 'Body');
    await catsRepo.recordCategorization({
      postId: 'TEST-6',
      contentHash: hash,
      category: 'Life Events',
      confidence: 1,
      reasoning: '',
      model: 'm',
    });
    await draftsRepo.recordDraft({ postId: 'TEST-6', content: 'd', model: 'm' });

    const db = getDb();
    await db.execute(sql`DELETE FROM posts WHERE id = 'TEST-6'`);

    const cats = await catsRepo.listForPost('TEST-6');
    expect(cats).toHaveLength(0);
    const draft = await draftsRepo.getLatestDraft('TEST-6');
    expect(draft).toBeNull();
  });
});
