# Benefits Support Triage — Technical Specification

**Status:** Implemented · v0.2.1
**Author:** John Baker
**Last revised:** 2026-05

## 1. Context and goals

Oracle HCM Cloud Benefits implementations generate a steady stream of customer
support questions: life events not opening enrollment windows, imputed income
calculations returning zero, COBRA notices stuck in pending, vendor extracts
dropping terminated employees. The questions are repetitive — a small number of
configuration patterns produce most of them — but the answers require domain
knowledge of specific Oracle setup tasks (Manage Plans and Programs, Manage
Eligibility Profiles, Manage Communication Types, etc.) and configuration
flows (Evaluate Life Event Participation, Refresh Open Enrollment Window).

This system is an agent tool that triages incoming support posts: classifying
them into a fixed Benefits taxonomy, surfacing the resolved response when one
already exists, and drafting a credible reply when one does not.

### Goals

- **Categorize** incoming posts against a fixed 10-category taxonomy
  with confidence scoring and a one-sentence rationale.
- **Persist** classifications as both cache and audit log so duplicate
  questions do not incur repeated LLM cost.
- **Draft** replies for open posts using a prompt grounded in Oracle HCM
  configuration patterns; mark drafts explicitly as requiring human review.
- **Demonstrate production patterns** appropriate for an enterprise SaaS
  context: dependency injection at the test seam, taxonomy enforcement,
  cache-correct provider swaps, graceful degradation.

### Non-goals

- **Auto-posting drafts.** Every drafted reply is gated on human review.
  This is non-negotiable for a tool whose output goes into a customer-facing
  forum.
- **End-to-end ticket lifecycle management.** This system does not assign
  tickets, escalate, route to specialists, or track SLAs. It triages and
  drafts; integration with a real ticketing system is a separate concern.
- **Multi-tenant isolation.** Single-tenant by design. Multi-tenant
  hardening (per-customer encryption, row-level security, isolated rate
  limits) is out of scope for the demo.
- **Authentication.** The API endpoints are unauthenticated locally.
  Production deployment requires an auth layer; that layer is not part of
  this spec.
- **Real-time ingestion.** Support posts are seeded into the database from
  a static fixture. A real ingestion pipeline (webhook, polling, queue) is
  a separate concern.

## 2. System overview

A React + Vite client renders a triage console. An Express server exposes
four routes; one fetches posts, two call LLM providers (categorize, draft),
one reports health. PostgreSQL persists posts, classifications, and drafts
through a Drizzle ORM repository layer. LLM providers are pluggable —
currently Anthropic (cloud) and Ollama (local) — and routes resolve their
provider independently, so cheap classification and quality drafting can
use different backends.

```
┌─────────────┐  /api/posts        ┌──────────────┐
│  React UI   │  /api/categorize   │  Express     │
│  (Vite)     │  /api/draft        │  /api/health │
└──────┬──────┘──────────────────► └──────┬───────┘
       │                                  │
       │                                  ├──► repositories ──► PostgreSQL
       │                                  │   (Drizzle ORM)     (Docker)
       │                                  │
       │                                  └──► LLMProvider ──┬─► Anthropic
       │                                                     └─► Ollama
       │
       └─ Provider per route is config-driven via
          LLM_PROVIDER, LLM_PROVIDER_TRIAGE, LLM_PROVIDER_DRAFT
```

## 3. Data model

Three tables. Schema lives in `server/db/schema/index.js`; migrations are
managed by drizzle-kit and committed to `server/db/migrations/`.

### `posts`

Primary key is the human-friendly external id (`CC-7821`) rather than a
synthetic UUID. The post id is stable across systems, appears in support
tooling, and shows up in URLs and logs. Trading off some flexibility (we
cannot accept duplicate ids from different sources) for debuggability.

| Column | Type | Notes |
|---|---|---|
| `id` | varchar(32), PK | External id, e.g. "CC-7821" |
| `title` | text NOT NULL | |
| `body` | text NOT NULL | |
| `status` | enum('open','answered') | |
| `source` | varchar(64) | E.g. "Customer Connect", "My Oracle Support" |
| `author` | varchar(256) | |
| `posted_at` | timestamptz | |
| `answer` | text | NULL when status = 'open' |
| `answered_by` | varchar(128) | NULL when status = 'open' |
| `seed_category_id` | varchar(32) | Used by the seeder; not authoritative |
| `created_at` | timestamptz, default now() | |
| `updated_at` | timestamptz, default now() | |

Indexed on `status` and `posted_at` to support the default UI sort and
status filters.

### `categorizations`

Append-only audit log of every categorization attempt. The same row
doubles as the cache: before calling the LLM, look up by
`(content_hash, model)`.

| Column | Type | Notes |
|---|---|---|
| `id` | int identity, PK | |
| `post_id` | varchar(32), FK → posts.id ON DELETE CASCADE | |
| `content_hash` | varchar(64) | SHA-256 of `title + "\n\n" + body` |
| `category` | varchar(64) | Validated against taxonomy before insert |
| `confidence` | real | Clamped to [0, 1] |
| `reasoning` | text | Optional model-generated rationale |
| `model` | varchar(64) | `<provider>:<model>`, e.g. `ollama:qwen2.5:7b` |
| `created_at` | timestamptz, default now() | |

Indexed on `post_id` (for history lookup) and `(content_hash, model)`
(for cache lookup).

### `drafts`

Similarly append-only. One row per draft generation. Latest by
`created_at` is the "current" draft surfaced in the UI.

| Column | Type | Notes |
|---|---|---|
| `id` | int identity, PK | |
| `post_id` | varchar(32), FK → posts.id ON DELETE CASCADE | |
| `content` | text NOT NULL | |
| `model` | varchar(64) | `<provider>:<model>` |
| `created_at` | timestamptz, default now() | |

Indexed on `post_id`.

### Cache key rationale

The `model` field stores `<provider>:<model>` — for example
`anthropic:claude-haiku-4-5-20251001` or `ollama:qwen2.5:7b`. Cache lookup
keys on this composite. The reasoning:

- **Provider swap invalidates correctly.** Moving from Ollama to Anthropic
  must not return a previously-cached Ollama categorization. The composite
  key handles this implicitly — `anthropic:claude-haiku` never matches a
  row stored under `ollama:qwen2.5:7b`.
- **Model upgrade invalidates correctly.** Bumping `claude-haiku-4-5` to
  `claude-haiku-5-0` produces a fresh classification. Old rows remain in
  the audit log.
- **Per-route swaps stay correct.** Per-route routing means triage may use
  Ollama while draft uses Anthropic. The cache for triage is keyed on
  triage's provider, not draft's. There is no scenario where a draft
  cache hit is served to a triage request.

The remaining gap: changes to the system prompt are **not** captured by
the cache key. If the prompt is rewritten, old cache entries continue to
serve. Mitigation discussed in §11.

## 4. Request flows

### Categorize

```
1. Client POST /api/categorize { postId, title, body }
2. Server validates title and body are non-empty (400 if not)
3. Server resolves the triage LLMProvider
4. Server computes content_hash = SHA-256(title + "\n\n" + body)
5. Server constructs cache key = "<provider>:<triageModel>"
6. SELECT FROM categorizations WHERE content_hash = ? AND model = ?
   ORDER BY created_at DESC LIMIT 1
7a. CACHE HIT:
    - If postId provided AND cached.post_id != postId,
      INSERT a new categorizations row referencing this postId
      (preserves per-post audit history without paying the LLM)
    - Return { category, confidence, reasoning, provider, cached: true }
7b. CACHE MISS:
    - provider.classify({ title, body, categories })
    - Parse JSON from response (handles fences and embedded JSON)
    - REJECT with 422 if returned category is not in the taxonomy
    - Clamp confidence to [0, 1]
    - If postId provided, INSERT a categorizations row
    - Return { category, confidence, reasoning, provider, cached: false }
```

### Draft

```
1. Client POST /api/draft { postId, title, body }
2. Server validates title and body (400 if missing)
3. Server resolves the draft LLMProvider
4. provider.draft({ title, body })  — no caching
5. If postId provided, INSERT a drafts row
6. Return { draft, provider }
```

Drafts are intentionally not cached. The same post should be able to
generate multiple drafts (regeneration is a UI affordance), and prompt
nondeterminism is a feature rather than a problem here.

### List

`GET /api/posts` returns all posts joined with their latest categorization
and latest draft, computed via a window-function CTE in raw SQL (Drizzle
does not natively express `DISTINCT ON` cleanly). The shape matches the
client's existing in-memory representation, so the React layer accepts
either source interchangeably.

## 5. LLM provider abstraction

### Interface

Every adapter implements this contract:

```javascript
{
  name: string,             // 'anthropic' | 'ollama'
  triageModel: string,      // identifier persisted to db
  draftModel: string,       // identifier persisted to db
  classify: ({ title, body, categories }) => Promise<string>,
  draft: ({ title, body }) => Promise<string>,
}
```

`classify` and `draft` return raw text. JSON extraction lives in shared
code so adapters stay thin — they translate transport (HTTP shape, headers,
auth), not semantics (prompts, parsing).

### Registry resolution

`createProviders(env)` returns `{ triage, draft }` based on env vars.
Resolution order:

```
/api/categorize  →  LLM_PROVIDER_TRIAGE  →  LLM_PROVIDER  →  'anthropic'
/api/draft       →  LLM_PROVIDER_DRAFT   →  LLM_PROVIDER  →  'anthropic'
```

Three intended configurations:

| Configuration | Use case |
|---|---|
| `LLM_PROVIDER=anthropic` (only) | Production quality, paid |
| `LLM_PROVIDER=ollama` (only) | Offline development, demos, CI |
| `LLM_PROVIDER_TRIAGE=ollama`, `LLM_PROVIDER_DRAFT=anthropic` | Cost-optimized — cheap classify, quality draft |

When triage and draft resolve to the same provider, the registry returns
the same adapter instance for both (object identity). This saves a
redundant fetch keep-alive pool and clarifies "the active provider" in
logs and the health endpoint.

### Adding a provider

Three steps, no route changes required:

1. Implement `createMyProvider(env)` in `server/llm/myprovider.js`.
2. Register it in `server/llm/index.js` `FACTORIES`.
3. Add adapter tests stubbing `global.fetch`.

## 6. Taxonomy gate

The 10-category taxonomy is hardcoded in `src/lib/categories.js` (client)
and `server/app.js` (server). Both must stay in sync; categorization
returns from the server are validated against the server's copy.

Any LLM response with a `category` field outside the taxonomy returns
HTTP **422 Unprocessable Entity** and is **not persisted**. The principle:
the LLM is allowed to be wrong about confidence and reasoning, but it is
not allowed to introduce new categories at runtime. This is the difference
between a triage tool and a free-form classifier.

The taxonomy gate is enforced in two places:

1. **Server** rejects with 422 before any database write.
2. **Client** drops categorizations whose label is not in the local
   taxonomy when applying batch results — defense in depth.

## 7. API contracts

### `GET /api/health`

Diagnostic. No state mutation. Used to confirm provider configuration
took effect.

```json
{
  "ok": true,
  "anthropicKeyConfigured": true,
  "databaseUrl": "configured",
  "triage": { "provider": "ollama", "model": "qwen2.5:7b" },
  "draft":  { "provider": "anthropic", "model": "claude-sonnet-4-6" }
}
```

### `GET /api/posts`

```json
{
  "posts": [
    {
      "id": "CC-7821",
      "title": "Birth life event not opening enrollment window",
      "body": "Customer reports...",
      "status": "answered",
      "source": "Customer Connect",
      "author": "jane.r@acmehealth.example",
      "postedAt": "2026-04-22T00:00:00.000Z",
      "answer": "Most often this is...",
      "answeredBy": "Oracle Support — SR escalated",
      "seedCategoryId": "life-events",
      "category": "Life Events",
      "confidence": 1.0,
      "reasoning": "Pre-categorized seed data",
      "draft": null
    }
  ]
}
```

### `POST /api/categorize`

Request:

```json
{ "postId": "CC-7821", "title": "...", "body": "..." }
```

Success response (cache miss):

```json
{
  "category": "Life Events",
  "confidence": 0.94,
  "reasoning": "The post describes a Birth life event failing to open an enrollment window.",
  "provider": "anthropic",
  "cached": false
}
```

Success response (cache hit) is identical except `cached: true` and the
underlying LLM call is skipped.

Error responses:

| Status | Cause |
|---|---|
| 400 | Missing title or body |
| 422 | Model returned a category outside the taxonomy |
| 500 | LLM provider error (Anthropic unreachable, Ollama not running, etc.) |

### `POST /api/draft`

Request:

```json
{ "postId": "CC-7821", "title": "...", "body": "..." }
```

Success response:

```json
{
  "draft": "Most often this is the Life Event Reason missing from the Program's Life Events tab...",
  "provider": "anthropic"
}
```

Error responses follow the same pattern as `/api/categorize`.

## 8. Test strategy

The suite follows a deliberate test pyramid:

| Layer | Count | Speed | What's mocked |
|---|---|---|---|
| Unit (libs, primitives, taxonomy, hashing) | ~50 | <50ms total | Nothing |
| Component (React) | 16 | ~1.5s | `src/lib/api.js` mocked at module level |
| Endpoint (Express) | 30+ | ~150ms | Repositories and providers injected |
| Adapter (Anthropic, Ollama) | 14 | ~20ms | `global.fetch` stubbed |
| Repository unit (hashContent) | 5 | <10ms | Nothing |
| Integration (live Postgres) | 6 | ~1s | Nothing — real DB round-trips |

### Why repository injection

The endpoint tests inject mock repositories into `createApp({ repos })`
rather than mocking the database driver. This means:

- Tests are fast because they do not spin up Postgres in CI.
- Tests do not depend on Drizzle's SQL generation being correct — the
  integration suite covers that separately, where it actually matters.
- Repositories serve as the architectural boundary between transport
  (HTTP) and persistence (SQL). Mocking at the boundary is more honest
  than mocking the SQL layer itself.

### Why integration tests gate on env

`server/db/repositories/integration.test.js` skips automatically unless
`TEST_DATABASE_URL` is set. The reasoning: these are slow (require a
container), they need a separate database, and they're failure modes
that don't reproduce in CI without setup work. They run when:

- The schema changes and we want to confirm Drizzle generated correct SQL.
- Before merging to main, as a CI gate.
- Locally, when debugging a specific Postgres-level issue.

### What's deliberately not tested

- **The actual quality of LLM responses.** The system prompt is
  evaluated by inspection, not by automated assertions about classification
  accuracy. This is a portfolio project, not a product — accuracy benchmarks
  are out of scope.
- **The Anthropic and Ollama wire formats themselves.** The adapter tests
  use stubbed `fetch`; if Anthropic ships an API change, the adapter test
  passes but production breaks. Acceptable for now; a contract test against
  a recorded Anthropic response would be the next step.
- **End-to-end browser tests.** No Playwright. The component tests cover
  rendering and interaction; the endpoint tests cover routing; the
  integration tests cover persistence. Adding Playwright would catch
  regressions in the seam between them, at significant CI cost.

## 9. Failure modes and observability

### Anticipated failures

| Failure | User sees | Server logs |
|---|---|---|
| Anthropic API 5xx | "Anthropic 503: overloaded" in error banner | `[categorize] Anthropic 503` or `[draft] Anthropic 503` |
| Ollama runtime not running | "Ollama unreachable at http://localhost:11434..." | Same, with port and connection error |
| Ollama model not pulled | "Ollama model qwen2.5:7b is not pulled. Run: ollama pull qwen2.5:7b" | Same |
| Postgres unreachable on `/api/posts` | "API unreachable — showing seed data only" banner; UI continues to function | `[posts.list] connection refused` |
| Postgres unreachable on `/api/categorize` | Error banner; UI keeps functioning | `[categorize] connection refused` |
| Off-taxonomy LLM response | 422 surfaced as error banner | `[categorize] returned category outside taxonomy` |

### Graceful degradation

The React UI calls `/api/posts` on mount. If that fails, it falls back to
seed data (`src/data/seedPosts.js`) and shows a "Demo mode" banner.
Categorize and draft buttons still work if the user provides an Anthropic
API key, even with no database — categorizations and drafts simply do not
persist across page refresh.

This is deliberate. The project must demo on a laptop without Docker
running, and a reviewer should not have to install Postgres to evaluate
the UI work.

### What's not observable

- **No metrics.** No Prometheus, no StatsD, no histograms of LLM latency,
  no cache hit rates over time. A real production deployment would want at
  minimum: per-route latency p50/p95/p99, cache hit rate, LLM cost per
  request (provider × model × tokens), and 4xx/5xx breakdown.
- **No tracing.** Request IDs are not propagated. A real deployment would
  benefit from OpenTelemetry spans across the route → provider → adapter
  call chain.
- **No structured logging.** `console.error('[scope]', error)` is unstructured.
  Pino or Winston with JSON output is the trivial upgrade.

These are acknowledged gaps, not oversights. They are listed in §12.

## 10. Decisions log

### Why Drizzle over Prisma

Considered: Prisma, Drizzle, Kysely, raw `pg`.

Chose Drizzle for three reasons:

- **The schema is JavaScript, not a DSL.** Prisma's `schema.prisma` is a
  separate language with its own generator step. Drizzle defines tables in
  `.js` files using normal imports and exports — this lets the same module
  be shared between schema, repository, and tests.
- **Migrations are SQL files I can read.** drizzle-kit generates plain
  `.sql` migrations that can be reviewed in a PR. Prisma's migration tool
  also generates SQL, but it tends to be uglier and the tooling is more
  opinionated about how it's applied.
- **No code generation step.** Prisma requires `prisma generate` to update
  the typed client after schema changes. Drizzle's types are inferred from
  the schema definition itself. One less build step, one less thing to
  forget.

The trade-off: Drizzle's query builder is less mature than Prisma's. The
list endpoint required a raw SQL CTE for a `DISTINCT ON`-style query
because Drizzle does not express it cleanly. This is acceptable; the raw
SQL is bounded and tested.

### Why repository injection over mocking the DB

Considered: testcontainers, in-memory SQLite, mocking Drizzle, mocking pg,
repository injection.

Chose repository injection because:

- It's honest about the architectural boundary. Repositories are where
  transport meets persistence; that is the right place to mock.
- Tests run in milliseconds rather than seconds. A test suite that takes
  5 seconds to feedback is a test suite that gets bypassed during
  iteration.
- It does not couple endpoint tests to Drizzle's API. If we swap to Kysely
  later, the endpoint tests don't change.

The trade-off: it's possible to write a route that the endpoint tests
accept but a real database rejects. This is what the integration test
suite (gated on `TEST_DATABASE_URL`) catches, and it has caught real
issues during development.

### Why content-hash caching instead of TTL

Considered: TTL cache (e.g. expire after 24h), content-hash cache, no
caching.

Chose content-hash because LLM categorizations are **idempotent over the
input**. The same post body produces the same category regardless of when
it was asked. TTL is the right model for data that goes stale (stock
prices, currency rates, weather). It is the wrong model for deterministic
classifications of stable text.

The remaining gap: prompt changes don't invalidate the cache. The
content-hash key encodes the post content but not the system prompt that
classified it. If the system prompt is rewritten, old cached entries
continue to serve. The fix is to encode a prompt version in the model
field — `claude-haiku-4-5@v2` — and bump it when the prompt changes.
Deferred to §12.

### Why per-route providers

Considered: single provider for both routes (simpler), per-route providers
(more flexibility).

Chose per-route because the typical real-world configuration has different
quality requirements for the two operations:

- **Triage** classifies into 10 categories. Haiku and Qwen-7B both do this
  reliably; a higher-quality model is overkill and 5–10x more expensive.
- **Draft** generates a credible reply mentioning specific Oracle setup
  tasks and Fast Formula references. This benefits noticeably from Sonnet
  or GPT-4-class quality.

The split lets you run Ollama for triage (free, local, fast) and Anthropic
for draft (paid, high quality) without code changes. The single-provider
case is still the default — set `LLM_PROVIDER` and both routes use it.

### Why a 10-category taxonomy

Considered: free-text classification, hierarchical taxonomy, fixed flat list.

Chose fixed flat list of 10 because:

- Oracle HCM Benefits has a natural division at this granularity (Life
  Events, Open Enrollment, Eligibility Profiles, Standard Rates, Plan
  Configuration, Vendor Extracts, Self-Service, Reports & Analytics, ACA
  Compliance, COBRA). These map to the actual modules and setup-task
  groupings in the application.
- A flat list is enforceable. Hierarchical taxonomies require LLM responses
  to traverse them correctly, which is a harder constraint to validate.
- Free-text classification is uncacheable and unreviewable. With a fixed
  list, an analytics dashboard can ask "what % of posts were Life Events
  this month" and get a real answer.

The trade-off: the taxonomy needs maintenance as Oracle ships new modules
or as the support traffic shifts. A real deployment would source it from
`Manage Common Lookups` or a config service rather than hardcoding it in
two source files.

### Why Postgres on port 5433

The default Postgres port is 5432. Docker Compose binds the container to
the host on 5433 instead, so the container coexists with a native Postgres
install on the developer's Mac (Homebrew, Postgres.app). The trade-off is
non-standardness — every connection string in the project specifies 5433
explicitly — in exchange for not requiring developers to stop their
existing Postgres before running the project.

## 11. Risks

### Prompt drift not captured by cache key

The cache key is `(content_hash, provider:model)`. Changes to the system
prompt do not invalidate cached categorizations. If the prompt is rewritten
to be stricter or more permissive, old cache entries continue to serve.

**Mitigation:** encode a prompt version in the model field, e.g.
`claude-haiku-4-5@v2`. Bump the suffix when the prompt changes. The cache
correctly invalidates and the audit log preserves which prompt version
produced which categorization.

**Status:** deferred. Listed in §12.

### Single-prompt-language assumption

Both adapters send English-language prompts. If incoming support posts
are translated or non-English, the model may return categories in a
different language and the taxonomy gate will reject them all with 422.

**Mitigation:** detect language at ingestion and route to a language-aware
prompt; or constrain the LLM with `format: 'json'` plus a strict schema.
Not currently a problem because seed data is English-only.

### Off-taxonomy responses are silently common with weaker models

The taxonomy gate works correctly — 422s are rejected and not persisted.
But local models (Ollama with Qwen-7B) return off-taxonomy categories
more often than Anthropic does. With JSON mode enabled (`format: 'json'`)
the response is at least valid JSON, but it may still contain a creative
category not in the list.

**Mitigation:** post-process Ollama responses to find the closest
taxonomy match by string similarity before applying the gate. Or use a
larger local model. Or limit local model use to development.

**Status:** acceptable for now. Documented as a known characteristic of
local models.

### Unauthenticated endpoints

The four routes have no authentication. Anyone with network access to
the server can list posts, generate categorizations, and produce drafts
— which has real cost when the active provider is Anthropic.

**Mitigation:** API key middleware in front of Express, or session-based
auth tied to an existing identity provider. Required before any production
deployment. Out of scope for the demo.

## 12. Deferred work

These are deliberate omissions, not oversights. Listed roughly in order
of importance.

- **Authentication.** The demo runs on `localhost`. Production needs an
  auth layer.
- **Rate limiting.** No rate limiting on the categorize/draft routes. A
  reviewer who batched 1,000 posts through the demo would incur real cost.
- **Job queue.** Categorize-all runs in `Promise.all`. Past ~50 concurrent
  posts, BullMQ + Redis is the appropriate primitive.
- **Prompt versioning in cache key.** Discussed in §11.
- **Semantic similarity for draft grounding.** Add pgvector to look up the
  N most similar previously-resolved posts and pass them into the draft
  prompt. The current draft is grounded only in the system prompt; a real
  agent would learn from past resolutions.
- **Structured logging and metrics.** Pino/JSON logs plus a metrics
  endpoint (Prometheus, OTel).
- **Contract tests against real LLM responses.** Adapter tests stub
  `fetch`. A recorded-response contract test would catch wire-format
  changes.
- **Multi-tenancy.** Single-tenant by design. Multi-tenant adds row-level
  security, per-tenant rate limits, per-tenant API keys, encryption at
  rest with customer-supplied keys.

## 13. Glossary

For readers not familiar with Oracle HCM Cloud Benefits:

- **Life Event** — a domain trigger that opens an enrollment window
  (Birth, Marriage, Divorce, Open Enrollment, etc.). Life Events are
  detected by configuration and trigger eligibility re-evaluation.
- **Eligibility Profile** — a rule defining which workers are eligible
  for a benefit (e.g., "full-time employees in California, hire date
  before 2024").
- **Standard Rate** — a calculation rule for a benefit cost (e.g.,
  "imputed income for Group Term Life over $50K, IRS Table I rates").
- **Open Enrollment** — the annual window when workers can change
  benefit elections without a qualifying life event.
- **COBRA** — federal continuation coverage available after termination.
  Generates a notice when a qualifying event is detected.
- **ACA Compliance** — Affordable Care Act reporting (Forms 1094-C,
  1095-C). Calculated from hours of service over a measurement period.
- **Vendor Extract** — outbound data file sent to a benefits carrier
  (Aetna, Cigna, etc.) listing covered employees and dependents.
- **Manage Plans and Programs** — an Oracle setup task where Benefits
  administrators configure plans, options, programs, and life events.
- **Manage Eligibility Profiles** — the setup task for defining and
  attaching eligibility rules.
- **VBCS** — Visual Builder Cloud Service, Oracle's low-code UI platform
  used to build custom Benefits pages alongside the standard application.
- **ADF** — Application Development Framework, Oracle's older Java-based
  UI framework. Many existing HCM administrative pages are still ADF.
- **Fast Formula** — Oracle's domain-specific language for expressing
  Benefits and Payroll calculations (rates, eligibility, deductions).
- **BI Publisher** — Oracle's reporting engine, used for custom reports
  and outbound data extracts.
