// server/app.js
// Express app factory. Both repositories AND the LLM providers are
// injectable so tests can run without a live Postgres or LLM.
//
// LLM providers are keyed per route:
//   POST /api/categorize  →  providers.triage
//   POST /api/draft       →  providers.draft
//
// The two are usually the same adapter (Anthropic or Ollama for everything),
// but can differ — e.g. Ollama for cheap local classify, Anthropic for
// quality drafts.

import express from 'express';
import cors from 'cors';

import * as defaultPostsRepo from './db/repositories/posts.js';
import * as defaultCategorizationsRepo from './db/repositories/categorizations.js';
import * as defaultDraftsRepo from './db/repositories/drafts.js';
import * as defaultRagRepo from './db/repositories/rag.js';          // ← add
import { createProviders, extractJson } from './llm/index.js';
import { runGroundedDraft } from './rag/groundedDraft.js';            // ← add

// The fixed taxonomy. Keep this in sync with src/lib/categories.js on the client.
export const CATEGORIES = [
  'Life Events',
  'Open Enrollment',
  'Eligibility Profiles',
  'Standard Rates',
  'Plan Configuration',
  'Vendor Extracts',
  'Self-Service',
  'Reports & Analytics',
  'ACA Compliance',
  'COBRA',
];

export { extractJson };

/**
 * Build the Express app. Injection points:
 *   repos       — { postsRepo, categorizationsRepo, draftsRepo }
 *   providers   — { triage, draft } each implementing LLMProvider
 *   llmProvider — single provider shortcut (back-compat); maps to both
 */
export function createApp({
  postsRepo = defaultPostsRepo,
  categorizationsRepo = defaultCategorizationsRepo,
  draftsRepo = defaultDraftsRepo,
  ragRepo = defaultRagRepo,          // ← add
  providers = null,
  llmProvider = null,
} = {}) {
  // Accept three injection shapes:
  //   1. providers: { triage, draft }      — per-route
  //   2. llmProvider: single provider      — same for both routes
  //   3. nothing                           — built lazily from env on first use
  let _providers = providers;
  if (!_providers && llmProvider) {
    _providers = { triage: llmProvider, draft: llmProvider };
  }
  function getProviders() {
    if (!_providers) _providers = createProviders();
    return _providers;
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // ---- Health -------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    let info;
    try {
      const { triage, draft } = getProviders();
      info = {
        triage: { provider: triage.name, model: triage.triageModel },
        draft: { provider: draft.name, model: draft.draftModel },
      };
    } catch (e) {
      info = { error: e.message };
    }
    res.json({
      ok: true,
      anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      databaseUrl: process.env.DATABASE_URL ? 'configured' : 'missing',
      ...info,
    });
  });

  // ---- Posts --------------------------------------------------------------

  app.get('/api/posts', async (_req, res) => {
    try {
      const rows = await postsRepo.listPosts();
      res.json({ posts: rows });
    } catch (e) {
      console.error('[posts.list]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Categorize ---------------------------------------------------------

  app.post('/api/categorize', async (req, res) => {
    try {
      const { postId, title, body } = req.body ?? {};
      if (!title || !body) {
        return res.status(400).json({ error: 'title and body are required' });
      }

      const { triage } = getProviders();
      // Cache key includes provider AND model so a swap invalidates stale entries
      const modelKey = `${triage.name}:${triage.triageModel}`;
      const contentHash = categorizationsRepo.hashContent(title, body);

      // 1. Cache lookup
      const cached = await categorizationsRepo.findCached({ contentHash, model: modelKey });
      if (cached) {
        if (postId && cached.postId !== postId) {
          await categorizationsRepo.recordCategorization({
            postId,
            contentHash,
            category: cached.category,
            confidence: cached.confidence,
            reasoning: cached.reasoning,
            model: modelKey,
          });
        }
        return res.json({
          category: cached.category,
          confidence: cached.confidence,
          reasoning: cached.reasoning,
          provider: triage.name,
          cached: true,
        });
      }

      // 2. LLM call
      const text = await triage.classify({ title, body, categories: CATEGORIES });
      const json = extractJson(text);

      if (!CATEGORIES.includes(json.category)) {
        return res.status(422).json({
          error: 'Model returned a category outside the taxonomy',
          got: json,
          provider: triage.name,
        });
      }

      const category = json.category;
      const confidence = Math.max(0, Math.min(1, Number(json.confidence) || 0));
      const reasoning = json.reasoning ?? '';

      // 3. Persist
      if (postId) {
        await categorizationsRepo.recordCategorization({
          postId,
          contentHash,
          category,
          confidence,
          reasoning,
          model: modelKey,
        });
      }

      res.json({ category, confidence, reasoning, provider: triage.name, cached: false });
    } catch (e) {
      console.error('[categorize]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Draft --------------------------------------------------------------

  app.post('/api/draft', async (req, res) => {
    try {
      const { postId, title, body } = req.body ?? {};
      if (!title || !body) {
        return res.status(400).json({ error: 'title and body are required' });
      }

      const { draft } = getProviders();
      const text = await draft.draft({ title, body });
      const drafted = text.trim();

      if (postId) {
        await draftsRepo.recordDraft({
          postId,
          content: drafted,
          model: `${draft.name}:${draft.draftModel}`,
        });
      }

      res.json({ draft: drafted, provider: draft.name });
    } catch (e) {
      console.error('[draft]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Grounded draft (RAG) ----------------------------------------------

  app.post('/api/draft/grounded', async (req, res) => {
    try {
      const { postId, title, body } = req.body ?? {};
      if (!title || !body) {
        return res.status(400).json({ error: 'title and body are required' });
      }

      const { draft } = getProviders();
      const caseText = `${title}\n\n${body}`;

      const result = await runGroundedDraft({ caseText, provider: draft, ragRepo });

      // Persist only real drafts (not abstentions), same as /api/draft.
      if (!result.abstained && postId) {
        await draftsRepo.recordDraft({
          postId,
          content: result.draft,
          model: `${draft.name}:${draft.draftModel}`,
        });
      }

      res.json({ ...result, provider: draft.name });
    } catch (e) {
      console.error('[draft.grounded]', e);
      res.status(500).json({ error: e.message });
    }
  });
  return app;
}
