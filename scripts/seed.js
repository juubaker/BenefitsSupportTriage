// scripts/seed.js
// Idempotent seed for local development. Loads the canonical 10 support
// posts and, for any post with a `seedCategory`, records a corresponding
// "Pre-categorized seed data" entry in the categorizations table so the
// UI shows them as already-classified on first load.
//
// Run with: npm run db:seed

import 'dotenv/config';
import { SEED_POSTS } from '../src/data/seedPosts.js';
import * as postsRepo from '../server/db/repositories/posts.js';
import * as catsRepo from '../server/db/repositories/categorizations.js';
import { closeDb } from '../server/db/client.js';

// Mirror of the categories taxonomy (id -> label) used by the seeder.
// Kept in sync with src/lib/categories.js.
const SEED_CATEGORY_LABELS = {
  'life-events': 'Life Events',
  'open-enrollment': 'Open Enrollment',
  eligibility: 'Eligibility Profiles',
  rates: 'Standard Rates',
  'plan-config': 'Plan Configuration',
  extracts: 'Vendor Extracts',
  'self-service': 'Self-Service',
  reports: 'Reports & Analytics',
  aca: 'ACA Compliance',
  cobra: 'COBRA',
};

async function main() {
  console.log(`▸ Seeding ${SEED_POSTS.length} posts…`);

  let postsCreated = 0;
  let catsCreated = 0;

  for (const p of SEED_POSTS) {
    await postsRepo.upsertPost({
      id: p.id,
      title: p.title,
      body: p.body,
      status: p.status,
      source: p.source,
      author: p.author,
      postedAt: p.posted, // YYYY-MM-DD parses to midnight UTC; fine for seed
      answer: p.answer,
      answeredBy: p.answeredBy,
      seedCategoryId: p.seedCategory ?? null,
    });
    postsCreated += 1;

    // For pre-categorized posts, record a categorization row only if there
    // isn't one already (idempotent re-runs).
    if (p.seedCategory) {
      const label = SEED_CATEGORY_LABELS[p.seedCategory];
      if (!label) {
        console.warn(`  · ${p.id}: unknown seedCategory "${p.seedCategory}", skipping`);
        continue;
      }
      const contentHash = catsRepo.hashContent(p.title, p.body);
      const existing = await catsRepo.findCached({ contentHash, model: 'seed' });
      if (!existing) {
        await catsRepo.recordCategorization({
          postId: p.id,
          contentHash,
          category: label,
          confidence: 1.0,
          reasoning: 'Pre-categorized seed data',
          model: 'seed',
        });
        catsCreated += 1;
      }
    }
  }

  console.log(`  ✓ ${postsCreated} posts upserted`);
  console.log(`  ✓ ${catsCreated} pre-categorizations recorded`);
  await closeDb();
}

main().catch((err) => {
  console.error('✗ Seed failed:', err);
  process.exit(1);
});
