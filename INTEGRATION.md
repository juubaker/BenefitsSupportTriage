# Wiring the grounded draft into your app (v2 — matches your architecture)

This version respects what your `app.js` actually does: **repository injection**
and the **per-route provider abstraction** (`providers.draft`). No raw pool in
the route, no hardcoded Anthropic call.

## Files

```
server/rag/embed.js                  query embedding (Ollama, matches ingest)
server/rag/groundedDraft.js          orchestrator: retrieve -> draft -> verify -> log
server/db/repositories/rag.js        RAG repo (pgvector queries + log), injectable
server/db/pool.js                    pg pool — ONLY if your repos don't share one
src/components/RagDraftPanel.jsx      reviewer pane
patches/app.js.patch.js              the route + injection to add to createApp
patches/adapters-draftGrounded.md    the draftGrounded() method for each adapter
```

No new server dependencies — `express`, `pg`, `fetch` only.

## Steps

**1. Copy the files** to the paths shown.

**2. Fix the db handle in `rag.js`.** It imports `{ pool } from '../pool.js'`.
Open your existing `posts.js` / `drafts.js` and match how they connect:
- They import a shared `pool` → keep `pool.js`, done.
- They import a Drizzle `db` → import that instead; ping me for the Drizzle SQL form.
Either way, don't create a second pool against the same database.

**3. Add the `draftGrounded` method** to each adapter in `server/llm/` — see
`patches/adapters-draftGrounded.md` (Anthropic + Ollama provided). This is what
keeps the route honoring `LLM_PROVIDER`. *If your adapters already expose a
generic completion method, skip this and point `groundedDraft.js` at it.*

**4. Patch `app.js`** — apply `patches/app.js.patch.js`: two imports, add
`ragRepo = defaultRagRepo` to the `createApp` params, and paste the
`/api/draft/grounded` route after the existing `/api/draft` block.

**5. Environment** (the server process already has most of these):
```
DATABASE_URL=postgresql://triage:triage@localhost:5433/triage
ANTHROPIC_API_KEY=...                 # only if LLM_PROVIDER includes anthropic
OLLAMA_URL=http://localhost:11434
OLLAMA_EMBED_MODEL=nomic-embed-text   # MUST match what ingest used
POLICY_K=5
PRECEDENT_K=3
MIN_SIMILARITY=0.45
```
Ollama must be running (the query gets embedded on every request).

**6. Render** `<RagDraftPanel post={selectedPost} />` in your right pane.
`post` is `{ id, title, body }`.

## Smoke-test

```bash
curl -s http://localhost:3001/api/draft/grounded \
  -H "Content-Type: application/json" \
  -d '{"title":"Marriage","body":"I just got married, can I add my spouse now?"}' | jq
```

Expect a `draft` with a verified `[policy:N]` citation. An off-topic body should
return `"abstained": true`.

## Why it slots in cleanly

- **Testable like your other routes:** `runGroundedDraft({ caseText, provider,
  ragRepo })` takes its provider and repo as arguments, so a test injects stubs
  for both — no Postgres, no live LLM — exactly the pattern `createApp` already
  enables.
- **Provider-agnostic:** the orchestrator only calls `provider.draftGrounded`;
  it never names Anthropic or Ollama. `LLM_PROVIDER` works as it does everywhere
  else.
- **Same persistence path:** the route records the draft via `draftsRepo` just
  like `/api/draft`, and additionally writes a `retrieval_log` row (your audit
  trail + eval seed).

## The one open question

If your `server/llm/` adapters already have a generic completion method, paste
one adapter (e.g. the Anthropic one) and I'll point the orchestrator straight at
it so you don't add `draftGrounded` at all. Otherwise the two methods in
`adapters-draftGrounded.md` are ready to drop in.
