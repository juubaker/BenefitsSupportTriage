// ============================================================================
// PATCH for server/app.js — adds POST /api/draft/grounded
// Mirrors your existing /api/draft route: same input shape, persists via
// draftsRepo, routes through providers.draft. Adds RAG grounding + citations.
// ============================================================================

// 1. ADD these imports near the top, with the other repo/llm imports:
import * as defaultRagRepo from './db/repositories/rag.js';
import { runGroundedDraft } from './rag/groundedDraft.js';

// 2. ADD `ragRepo` to the createApp destructured params (alongside draftsRepo):
//
//    export function createApp({
//      postsRepo = defaultPostsRepo,
//      categorizationsRepo = defaultCategorizationsRepo,
//      draftsRepo = defaultDraftsRepo,
//      ragRepo = defaultRagRepo,          // <-- add this line
//      providers = null,
//      llmProvider = null,
//    } = {}) {

// 3. ADD this route inside createApp, right after the existing /api/draft block
//    (before `return app;`):

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

      // Persist only real drafts (not abstentions), same as /api/draft does.
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
