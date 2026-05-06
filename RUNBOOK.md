# Benefits Support Triage — Run & Test Guide

## What this project is

An Oracle HCM Cloud Benefits support triage tool. Incoming support posts are
classified against a fixed Benefits taxonomy (Life Events, Open Enrollment,
COBRA, ACA Compliance, etc.) and either matched to an existing resolved
response or used to generate an AI-drafted reply. Built as a working agent
tool that could plug into Oracle's AI Agent framework or Anthropic's tool-use API.

The architecture deliberately demonstrates a few production patterns:

- A persistence layer keyed on a content hash, so duplicate questions don't
  hit the LLM twice. The `categorizations` table doubles as both cache and
  audit log.
- A repository pattern between Express routes and Drizzle, so endpoint tests
  inject mocks instead of needing a live database.
- A taxonomy gate: any model output outside the fixed category list is
  rejected with a 422 before persistence. The LLM cannot pollute the data
  model with hallucinated categories.
- A graceful fallback: if Postgres is unreachable the UI loads from seed
  data and shows a "Demo mode" banner, so the project demos on any laptop.

## Stack at a glance

| Layer | Technology |
|---|---|
| Client | React 18, Vite 7, Tailwind CSS 3 |
| Server | Node 20+, Express 4 |
| Database | PostgreSQL 16, Drizzle ORM 0.45, drizzle-kit migrations |
| Tests | Vitest 3, Testing Library, happy-dom, Supertest |
| AI | Anthropic API — Haiku for triage, Sonnet for drafting |
| Local infra | Docker Compose (Postgres + Adminer) |

## Prerequisites

Verify these are installed before starting:

```bash
node --version       # need v20+
npm --version
docker --version     # Docker Desktop, OrbStack, or Colima
```

You also need an Anthropic API key from https://console.anthropic.com/settings/keys.
Without it the UI still loads but the categorize/draft buttons return 500.

## Running the project

From the project root:

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
# Open .env in any editor and paste your ANTHROPIC_API_KEY

# 3. Start Postgres, run migrations, seed the database
npm run db:setup

# 4. Run client + server together
npm run dev
```

Open http://localhost:5173 in a browser. The terminal will show two
interleaved streams of output prefixed `[server]` and `[client]`.

To stop: `Ctrl+C` in the terminal. To shut down the database container as
well, run `npm run db:down`.

### What `npm run db:setup` does

It is a chain of four commands:

```
db:up      → docker compose up -d postgres   (boots a Postgres container)
db:wait    → polls until Postgres accepts connections
db:migrate → drizzle-kit migrate              (creates the 3 tables)
db:seed    → loads the 10 seed support posts
```

If the database is already running, the chain is idempotent — `db:up` is a
no-op, migrations skip if applied, and the seed uses `INSERT ... ON CONFLICT
DO UPDATE` so reseeding is safe.

### What you should see when it works

The browser shows a triage console with three panes: filters and stats on
the left, the post queue in the middle, and a detail view on the right.
Five posts arrive pre-categorized (the answered ones, with their resolved
responses visible). Five arrive uncategorized.

Click "Categorize 5 new" in the header — the agent classifies all five
against the taxonomy in parallel. Open posts now show a "Generate draft
response" button that calls the LLM with a system prompt grounded in
Oracle HCM Benefits configuration tasks.

Refresh the page. Categorizations and drafts persist — they came back
from Postgres, not memory.

## Database inspection

If you want to look at the data directly:

**Adminer** — a lightweight web UI for the database:

http://localhost:8080
- System: PostgreSQL
- Server: postgres
- Username: triage
- Password: triage
- Database: triage

**Drizzle Studio** — Drizzle's own browser-based editor:

```bash
npm run db:studio
```

Opens https://local.drizzle.studio in your browser.

After running through the UI once, you should see ten rows in `posts`,
five seed entries in `categorizations` plus any new ones you triggered,
and one row in `drafts` per post you generated a draft for.

## Testing

The test suite covers every layer with appropriate isolation. Every test
runs in under 30 seconds end-to-end and never touches the network.

```bash
npm test               # one-shot run of every test
npm run test:watch     # watch mode (re-runs on file change)
npm run test:ui        # browser-based runner at http://localhost:51204
npm run test:coverage  # coverage report into ./coverage/
npm run test:server    # only server-side tests
npm run test:client    # only client-side tests
```

### Expected output

```
Test Files  7 passed | 1 skipped (8)
     Tests  85 passed | 6 skipped (91)
```

The skipped tests are the live-database integration tests in
`server/db/repositories/integration.test.js`. They opt in via an environment
variable, see the next section.

### What's tested at each layer

| Layer | File | What it tests |
|---|---|---|
| Server endpoints | `server/app.test.js` | Route contracts, request validation, taxonomy enforcement (422 on off-taxonomy categories), upstream API error handling, cache hit/miss behavior, persistence boundaries |
| Repository unit | `server/db/repositories/categorizations.test.js` | Content hashing — determinism, boundary sensitivity |
| Repository integration | `server/db/repositories/integration.test.js` | Real Postgres round-trips — upsert, latest-cat join via window function, cache lookup, cascade delete. Skipped unless `TEST_DATABASE_URL` is set |
| Client API | `src/lib/api.test.js` | Fetch wrappers — request shape, error handling for both JSON and text error bodies |
| Taxonomy | `src/lib/categories.test.js` | Schema invariants — uniqueness, helper lookup correctness |
| Seed data | `src/data/seedPosts.test.js` | Data integrity — required fields, ID uniqueness, answered/open consistency, valid `seedCategory` references |
| UI primitives | `src/components/ui.test.jsx` | CategoryChip, ConfidenceBar, StatusDot, StatBlock, FilterRow rendering and event handling |
| Integration | `src/components/BenefitsSupportTriage.test.jsx` | Loading state, API fetch, fallback on API failure, filtering, post selection, draft generation, batch categorization, off-taxonomy rejection at the UI layer |

### Test isolation strategy

The endpoint tests inject mock repositories into `createApp()`. They never
touch a real Postgres. The component tests mock `src/lib/api.js`. They
never even hit the local Express server. Tests run in roughly two seconds
of actual test time — the rest of the wall clock is Vitest setup and
test-environment startup.

The integration tests against a real Postgres are gated on a separate env
variable so they only run when explicitly requested:

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://triage:triage@localhost:5433/triage_test \
  npm run db:migrate
TEST_DATABASE_URL=postgresql://triage:triage@localhost:5433/triage_test \
  npx vitest run server/db/repositories/integration.test.js
```

This is a deliberate test-pyramid choice. Fast tests run on every save.
Slow tests run when the schema changes or when validating Drizzle's SQL
generation against a real database.

## Troubleshooting

### Port 3001 already in use (`EADDRINUSE`)

A previous `npm run dev` left an orphaned Node process holding the port.
Kill it:

```bash
lsof -ti :3001 | xargs kill
```

Then `npm run dev` again.

### Port 5433 conflicts with native Postgres

The project uses port **5433** specifically to coexist with a native
Postgres install on the default port 5432. If you have something else
already on 5433, edit the host port in `docker-compose.yml` and update the
matching port in `DATABASE_URL` in `.env`.

### "role triage does not exist" during migration

Means drizzle-kit connected to a Postgres other than the Docker container —
typically a native Homebrew or Postgres.app install. Confirm with:

```bash
lsof -i :5433        # should show only com.docker
```

If you see a `postgres` process there too, stop it (`brew services stop
postgresql` or close Postgres.app).

### Tests fail with "happy-dom is not installed"

Re-run `npm install` — happy-dom is a dev dependency that may have been
skipped if you used `npm install --production`.

## Project layout

```
benefits-support-triage/
├── docker-compose.yml             ← local Postgres + Adminer
├── drizzle.config.js              ← drizzle-kit config
├── eslint.config.js               ← ESLint 9 flat config
├── vitest.config.js               ← test runner config
│
├── server/
│   ├── app.js                     ← Express app factory (dependency-injectable)
│   ├── app.test.js                ← endpoint tests with mock repos
│   ├── index.js                   ← thin entry point — dotenv + listen
│   └── db/
│       ├── client.js              ← Drizzle + pg pool (singleton)
│       ├── schema/index.js        ← table definitions + relations
│       ├── migrations/            ← drizzle-kit generated SQL
│       └── repositories/          ← data access — the test seam
│           ├── posts.js
│           ├── categorizations.js
│           ├── drafts.js
│           └── integration.test.js
│
├── src/
│   ├── components/
│   │   ├── BenefitsSupportTriage.jsx  ← top-level container
│   │   ├── Header.jsx
│   │   ├── Sidebar.jsx
│   │   ├── PostList.jsx
│   │   ├── PostDetail.jsx
│   │   └── ui.jsx                 ← shared primitives
│   ├── data/seedPosts.js          ← 10 realistic Benefits support posts
│   └── lib/
│       ├── api.js                 ← fetch wrappers
│       └── categories.js          ← taxonomy single source of truth
│
├── scripts/
│   ├── seed.js                    ← idempotent seed runner
│   └── wait-for-db.js             ← polls Postgres readiness
│
└── .vscode/                       ← workspace-shared editor config
    ├── settings.json
    ├── extensions.json            ← recommended extensions
    └── launch.json                ← debug configs for app + tests
```

## What I'd do next given more time

Items deliberately out of scope for this build but worth flagging:

- **Job queue.** Categorization runs in `Promise.all` today. Past ~50
  concurrent posts a queue (BullMQ + Redis) is appropriate so the LLM
  rate limits aren't a per-request concern.
- **Semantic similarity for draft grounding.** Add pgvector to look up the
  N most similar previously-resolved posts and pass them into the draft
  prompt. The current draft is grounded only in the system prompt; a real
  agent would learn from past resolutions.
- **Prompt versioning.** The cache key is `(content_hash, model)`. Bumping
  the model invalidates automatically. The system prompt currently has
  no version, so changing it does not invalidate the cache. Encoding a
  prompt version in the model field (`claude-haiku-4-5@v2`) is the cleanest
  fix.
- **Authentication.** The /api endpoints are unauthenticated. For a
  production deployment, an API key or session-based auth in front of
  Express is the next step.
