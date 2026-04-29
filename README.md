# Benefits Support Triage Agent

An Oracle HCM Cloud Benefits support triage tool. Categorizes incoming support
posts against a fixed Benefits taxonomy and surfaces the resolved response, or
generates an AI-drafted reply for open posts.

## Stack

- **Client** — React 18, Vite 5, Tailwind CSS 3, Manrope + Fraunces + JetBrains Mono
- **Server** — Node 20+, Express 4, raw `fetch` against the Anthropic Messages API
- **Database** — PostgreSQL 16, [Drizzle ORM](https://orm.drizzle.team/) + drizzle-kit migrations, `node-postgres` pool
- **Tests** — Vitest 2, Testing Library, happy-dom, supertest
- **Models** — Haiku for fast classification, Sonnet for the drafted response (configurable)

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# then open .env and paste your Anthropic API key

# 3. Boot Postgres + run migrations + seed
npm run db:setup

# 4. Run both client and server
npm run dev
```

- Client: <http://localhost:5173>
- API:    <http://localhost:3001/api/health>
- Adminer (DB UI): <http://localhost:8080>  — System: PostgreSQL, Server: postgres, User/Pass/DB: triage

If Postgres isn't running, the UI falls back to in-memory seed data and shows
a "Demo mode" banner. Categorizations and drafts won't persist, but the UI
still works for a quick demo.

## Architecture

```
┌─────────────┐  /api/posts        ┌──────────────┐
│  React UI   │  /api/categorize   │  Express     │
│  (Vite)     │  /api/draft        │  /api/health │
└──────┬──────┘──────────────────► └──────┬───────┘
       │                                  │
       │                                  │ ┌──────────────┐
       │                                  ├►│  repositories│
       │                                  │ │  (Drizzle)   │
       │                                  │ └──────┬───────┘
       │                                  │        ▼
       │                                  │ ┌──────────────┐
       │                                  │ │  PostgreSQL  │
       │                                  │ │  (docker)    │
       │                                  │ └──────────────┘
       │                                  ▼
       │                            ┌────────────────┐
       │                            │  Anthropic API │
       │                            │  Haiku/Sonnet  │
       │                            └────────────────┘
```

**Cache flow on POST /api/categorize:**

1. Hash `title + body` → `content_hash`
2. SELECT from `categorizations` WHERE `content_hash + model` matches → cache hit, return immediately
3. On miss: call Anthropic, validate against taxonomy, INSERT, return

This means duplicate or near-duplicate questions don't hit Anthropic twice.
The `categorizations` table doubles as the audit log.

## Database

### Schema

Three tables in `server/db/schema/index.js`:

| Table | Purpose |
|---|---|
| `posts` | The support posts. Primary key is the human-friendly id (`CC-7821`). |
| `categorizations` | Per-classification audit + cache. Indexed on `(content_hash, model)`. Cascade-deletes with the post. |
| `drafts` | AI-generated drafts so they survive a refresh. Cascade-deletes with the post. |

### Scripts

```bash
npm run db:up         # docker compose up -d (Postgres + Adminer)
npm run db:down       # docker compose down (preserves volume)
npm run db:reset      # docker compose down -v && setup (NUKES the volume)

npm run db:wait       # block until Postgres accepts connections
npm run db:generate   # drizzle-kit generate (after editing the schema)
npm run db:migrate    # apply pending migrations
npm run db:push       # push schema directly without migration files (dev only)
npm run db:studio     # drizzle-kit studio at https://local.drizzle.studio
npm run db:seed       # populate the 10 seed support posts

npm run db:setup      # up + wait + migrate + seed   (one-shot for new clones)
```

### Hosting it for real

The `DATABASE_URL` in `.env` is just a connection string — point it at
**Neon**, **Supabase**, **RDS**, or anything else that speaks Postgres. No
code changes needed. For free hosting suitable for portfolio demos:

- [Neon](https://neon.tech) — serverless Postgres, free tier with 0.5 GB
- [Supabase](https://supabase.com) — Postgres + auth + storage, free tier with 500 MB

## Open in VS Code

```bash
code benefits-support-triage.code-workspace
```

Recommended extensions auto-prompt on open: Tailwind IntelliSense, ESLint,
Error Lens, Prettier, Vitest Test Explorer, dotenv.

`.vscode/launch.json` includes:

- "Debug: Triage API server" — Express with debugger attached
- "Debug: Vite client" — Chrome at `localhost:5173`
- "Debug: Vitest — current file" / "Debug: Vitest — all tests"
- "Debug: Full stack" compound — boots both server and client

## Testing

```bash
npm test               # one-shot run
npm run test:watch     # watch mode
npm run test:ui        # browser-based runner at :51204
npm run test:coverage  # text + HTML coverage into ./coverage
npm run test:server    # only server/ tests
npm run test:client    # only src/ tests
```

### Coverage

| Layer | File | What it tests |
|---|---|---|
| Server | `server/app.test.js` | Endpoint contracts, validation, taxonomy enforcement (422), upstream errors, **cache hit/miss behavior**, persistence (recordCategorization called or not based on postId) |
| Server (integration) | `server/db/repositories/integration.test.js` | Real Postgres round-trips: upsert, latest-cat join, cache lookup, cascade delete. **Skipped unless `TEST_DATABASE_URL` is set.** |
| Repository (unit) | `server/db/repositories/categorizations.test.js` | `hashContent` determinism + boundary sensitivity |
| Lib | `src/lib/categories.test.js` | Taxonomy shape, ID/label uniqueness, helper lookups |
| Lib | `src/lib/api.test.js` | Fetch wrappers — `listPosts`, `categorizePost`, `draftResponse`, `getHealth` |
| Data | `src/data/seedPosts.test.js` | Required fields, ID uniqueness, answered/open consistency |
| UI primitives | `src/components/ui.test.jsx` | CategoryChip, ConfidenceBar, StatusDot, StatBlock, FilterRow |
| Integration | `src/components/BenefitsSupportTriage.test.jsx` | Loading state, API fetch, fallback on API failure, filters, post selection, draft generation, batch categorization |

The component test mocks `src/lib/api.js`. The server test injects mock
repositories into `createApp()` so it never touches a real Postgres. The
real-DB integration tests opt in via `TEST_DATABASE_URL`.

### Running integration tests against a real DB

```bash
docker compose up -d postgres
createdb -h localhost -U triage triage_test   # or via Adminer
TEST_DATABASE_URL=postgresql://triage:triage@localhost:5433/triage_test \
  npm run db:migrate
TEST_DATABASE_URL=postgresql://triage:triage@localhost:5433/triage_test \
  npx vitest run server/db/repositories/integration.test.js
```

## API surface

### `GET /api/posts`

Returns all posts joined with their latest categorization and draft.

```json
{
  "posts": [
    {
      "id": "CC-7821",
      "title": "Birth life event not opening enrollment window",
      "body": "...",
      "status": "answered",
      "category": "Life Events",
      "confidence": 1.0,
      "reasoning": "Pre-categorized seed data",
      "draft": null,
      ...
    }
  ]
}
```

### `POST /api/categorize`

```json
// request
{ "postId": "CC-7821", "title": "...", "body": "..." }

// response (cache miss)
{ "category": "Life Events", "confidence": 0.94, "reasoning": "...", "cached": false }

// response (cache hit)
{ "category": "Life Events", "confidence": 0.94, "reasoning": "...", "cached": true }
```

### `POST /api/draft`

```json
// request
{ "postId": "CC-7821", "title": "...", "body": "..." }

// response
{ "draft": "Most often this is the Life Event Reason missing from..." }
```

The category must be one of the labels in `src/lib/categories.js`. The
server rejects any model output that falls outside the taxonomy with a 422
**before** persisting it.

## Plugging into an agent framework

The two POST routes are shaped so they can be lifted directly into an agent
tool definition (Anthropic tool use, Oracle's AI agent framework, LangChain).

```ts
tools: [
  {
    name: 'categorize_support_post',
    description: 'Classify an Oracle HCM Benefits support post into one of 10 categories.',
    input_schema: {
      type: 'object',
      properties: {
        postId: { type: 'string' },
        title:  { type: 'string' },
        body:   { type: 'string' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'draft_support_response',
    description: 'Draft a senior-consultant reply to an Oracle HCM Benefits support post.',
    input_schema: { /* same shape */ },
  },
]
```

## Production notes

- The Anthropic key is server-side only. Never move `callClaude` to the client.
- The cache key is `(content_hash, model)`. Bumping the model invalidates the
  cache automatically — no need to manually flush when you upgrade.
- For real volume, add a job queue (BullMQ) in front of the server routes so
  batch categorizations don't block.
- Add a TTL or invalidation policy on the cache if your taxonomy or system
  prompt changes — easiest is to alter the `model` field to include a prompt
  version (e.g. `claude-haiku-4-5-20251001@v2`).
- The `posts.id` primary key is the human-friendly id. If you ingest from a
  source that doesn't have stable IDs, switch to `cuid()` or `uuid` and
  store the external id in a separate column.

## License

MIT — for portfolio and internal demo use. Do not auto-post AI drafts to a
customer-facing forum without human review.
