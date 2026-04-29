// server/app.js
// Express app factory. Kept separate from index.js so tests can import the
// configured app without binding to a port.
//
// All persistence goes through the repositories layer in ./db/repositories/.
// The factory accepts a `repos` parameter so tests can inject mocks instead
// of needing a live Postgres.

import express from 'express';
import cors from 'cors';

import * as defaultPostsRepo from './db/repositories/posts.js';
import * as defaultCategorizationsRepo from './db/repositories/categorizations.js';
import * as defaultDraftsRepo from './db/repositories/drafts.js';

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

const env = (key, fallback) => process.env[key] ?? fallback;

async function callClaude({ model, system, prompt, maxTokens = 1000 }) {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new Error('Server missing ANTHROPIC_API_KEY. Set it in .env and restart.');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Build the Express app. Pass `repos` to inject test doubles.
 */
export function createApp({
  postsRepo = defaultPostsRepo,
  categorizationsRepo = defaultCategorizationsRepo,
  draftsRepo = defaultDraftsRepo,
} = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // ---- Health -------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      keyConfigured: Boolean(env('ANTHROPIC_API_KEY')),
      triageModel: env('ANTHROPIC_MODEL_TRIAGE', 'claude-haiku-4-5-20251001'),
      draftModel: env('ANTHROPIC_MODEL_DRAFT', 'claude-sonnet-4-6'),
      databaseUrl: env('DATABASE_URL') ? 'configured' : 'missing',
    });
  });

  // ---- Posts --------------------------------------------------------------

  /**
   * GET /api/posts
   * Returns all posts joined with their latest categorization and draft.
   */
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

  /**
   * POST /api/categorize
   * Body: { postId, title, body }
   *
   * Cache-aware: looks for an existing categorization with the same content
   * hash + model before calling the LLM. Always records the (cache hit or
   * fresh) result against the postId for audit/history.
   */
  app.post('/api/categorize', async (req, res) => {
    try {
      const { postId, title, body } = req.body ?? {};
      if (!title || !body) {
        return res.status(400).json({ error: 'title and body are required' });
      }

      const model = env('ANTHROPIC_MODEL_TRIAGE', 'claude-haiku-4-5-20251001');
      const contentHash = categorizationsRepo.hashContent(title, body);

      // 1. Cache lookup
      const cached = await categorizationsRepo.findCached({ contentHash, model });
      if (cached) {
        // Record this hit against the postId so history is preserved
        if (postId && cached.postId !== postId) {
          await categorizationsRepo.recordCategorization({
            postId,
            contentHash,
            category: cached.category,
            confidence: cached.confidence,
            reasoning: cached.reasoning,
            model,
          });
        }
        return res.json({
          category: cached.category,
          confidence: cached.confidence,
          reasoning: cached.reasoning,
          cached: true,
        });
      }

      // 2. LLM call
      const system =
        'You are a triage assistant for an Oracle HCM Cloud Benefits support team. ' +
        'Classify support posts into one of the provided categories. ' +
        'Respond with JSON only, no prose, no code fences.';
      const prompt =
        `Categories (use the exact label):\n${CATEGORIES.map((l) => `- ${l}`).join('\n')}\n\n` +
        `Post title: ${title}\n` +
        `Post body: ${body}\n\n` +
        `Return JSON: {"category": "<exact label>", "confidence": <0..1>, "reasoning": "<one sentence>"}`;
      const text = await callClaude({ model, system, prompt, maxTokens: 300 });
      const json = extractJson(text);

      if (!CATEGORIES.includes(json.category)) {
        return res.status(422).json({
          error: 'Model returned a category outside the taxonomy',
          got: json,
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
          model,
        });
      }

      res.json({ category, confidence, reasoning, cached: false });
    } catch (e) {
      console.error('[categorize]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Draft --------------------------------------------------------------

  /**
   * POST /api/draft
   * Body: { postId, title, body }
   * Persists the draft so it survives a refresh.
   */
  app.post('/api/draft', async (req, res) => {
    try {
      const { postId, title, body } = req.body ?? {};
      if (!title || !body) {
        return res.status(400).json({ error: 'title and body are required' });
      }

      const model = env('ANTHROPIC_MODEL_DRAFT', 'claude-sonnet-4-6');
      const system =
        'You are a senior Oracle HCM Cloud Benefits implementation consultant. ' +
        'You write concise, technically grounded answers for support posts. ' +
        'Reference setup task names (e.g., Manage Plans and Programs, Manage Eligibility Profiles), ' +
        'specific flows or processes, and Fast Formula or BI Publisher tables when relevant. ' +
        'Stay under 120 words. Plain text. No markdown headings.';
      const prompt =
        `Draft a support reply for the following post:\n\n` +
        `Title: ${title}\n` +
        `Body: ${body}\n\n` +
        `Reply directly. Do not include greetings or sign-offs.`;

      const text = await callClaude({ model, system, prompt, maxTokens: 600 });
      const draft = text.trim();

      if (postId) {
        await draftsRepo.recordDraft({ postId, content: draft, model });
      }

      res.json({ draft });
    } catch (e) {
      console.error('[draft]', e);
      res.status(500).json({ error: e.message });
    }
  });

  return app;
}
