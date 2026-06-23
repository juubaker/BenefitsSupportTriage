# RUNBOOK — Benefits Support Triage Agent + RAG (integrated)

Setup and operations for the version where the RAG layer is wired into the live
app: grounded drafts through the provider abstraction, retrieval as a repository,
citation verification, abstention, and the reviewer panel. This supersedes the
standalone-scaffold runbook.

If you only need the corpus/ingest mechanics, see `rag/RUNBOOK.md`. This document
covers the whole running system.

---

## 1. Architecture at a glance

| Component | Where | Notes |
|---|---|---|
| App server (Express) | `server/` | `createApp`, provider abstraction, repositories. Default port **3001** |
| React client (Vite) | `src/` | Three-pane reviewer UI |
| Postgres + pgvector | Docker container `triage-postgres` | Image `pgvector/pgvector:pg16`. Host port **5433** → container 5432 |
| RAG schema/ingest | `rag/` subfolder | Own `package.json` (CommonJS), Drizzle, `scripts/ingest.ts` |
| Embeddings | Ollama, `localhost:11434` | `nomic-embed-text` (768-dim) — must match between ingest and query |
| Draft LLM | per `LLM_PROVIDER` | Anthropic or Ollama, via `providers.draft.draftGrounded()` |

**Grounded-draft request flow:**

```
POST /api/draft/grounded { postId, title, body }
  -> embed(title+body)                         server/rag/embed.js
  -> ragRepo.searchPolicy / searchPrecedents   server/db/repositories/rag.js (pgvector)
  -> abstain if top similarity < MIN_SIMILARITY
  -> providers.draft.draftGrounded({system,user})   honors LLM_PROVIDER
  -> verify [policy:id] citations ⊆ retrieved
  -> draftsRepo.recordDraft + ragRepo.recordRetrievalLog
  -> reviewer panel renders draft + chips + evidence
```

**Critical constants for this environment (memorize these — they caused most of
the setup pain):**
- DB connection is **port 5433**, not 5432: `postgresql://triage:triage@localhost:5433/triage`
- Image must be `pgvector/pgvector:pg16` (stock `postgres` has no pgvector; `pg18` hits a data-dir mount change)
- Ingest **appends** — re-running duplicates rows unless you truncate first

---

## 2. Prerequisites

- Docker Desktop running
- Node 20+
- Ollama installed and running (`ollama serve`) with `nomic-embed-text` pulled
- `psql` client (macOS: `brew install libpq && brew link --force libpq`)
- Anthropic API key (only if `LLM_PROVIDER` includes `anthropic`)

---

## 3. One-time setup

### 3.1 Database container (with pgvector)

Confirm `docker-compose.yml` postgres service uses the pgvector image and host
port 5433:

```yaml
  postgres:
    image: pgvector/pgvector:pg16
    container_name: triage-postgres
    ports:
      - '5433:5432'
    environment:
      POSTGRES_USER: triage
      POSTGRES_PASSWORD: triage
      POSTGRES_DB: triage
    volumes:
      - triage-pgdata:/var/lib/postgresql/data
```

Start it:

```bash
npm run db:up
docker compose ps          # want: Up (healthy), 0.0.0.0:5433->5432/tcp
```

### 3.2 Environment

Set `DATABASE_URL` to **port 5433** in the root `.env` AND `rag/.env`:

```
DATABASE_URL=postgresql://triage:triage@localhost:5433/triage
```

App `.env` also needs (per your provider setup):
```
PORT=3001
LLM_PROVIDER=anthropic            # or ollama, or split LLM_PROVIDER_TRIAGE/DRAFT
ANTHROPIC_API_KEY=...             # if any provider is anthropic
OLLAMA_URL=http://localhost:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
POLICY_K=5
PRECEDENT_K=3
MIN_SIMILARITY=0.45
```

### 3.3 App schema + seed

```bash
npm run db:wait && npm run db:migrate && npm run db:seed
```

### 3.4 Enable pgvector

```bash
set -a; source .env; set +a        # load DATABASE_URL into the shell
psql "$DATABASE_URL" -f rag/db/0000_enable_pgvector.sql
psql "$DATABASE_URL" -c "\dx vector"     # confirm vector is listed
```

### 3.5 RAG tables + corpus (from the rag/ subfolder)

```bash
cd rag
npm install                        # rag/ has its own deps
grep DATABASE_URL .env             # confirm :5433
set -a; source .env; set +a
npx drizzle-kit generate
npx drizzle-kit migrate            # creates policy_chunks, resolved_tickets, retrieval_log
ollama pull nomic-embed-text
npm run ingest
cd ..
```

Verify:
```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM policy_chunks;"     # > 0
psql "$DATABASE_URL" -c "SELECT count(*) FROM resolved_tickets;"  # > 0
```

### 3.6 Integration code (one-time)

Place the wiring files (see `INTEGRATION.md`):
- `server/rag/embed.js`, `server/rag/groundedDraft.js`
- `server/db/repositories/rag.js`
- `src/components/RagDraftPanel.jsx`

Apply the two edits:
- `server/app.js` — add `ragRepo` injection + the `/api/draft/grounded` route
- `server/llm/` adapters — add the `draftGrounded({system,user})` method

---

## 4. Daily run

Three things must be up: Postgres, Ollama, the app.

```bash
npm run db:up                      # if the container isn't already running
ollama serve                       # in its own terminal, or launch the app
npm run dev                        # server (3001) + client, via concurrently
```

Health check:
```bash
curl -s http://localhost:3001/api/health | jq
```

---

## 5. Smoke tests

**Endpoint:**
```bash
curl -s http://localhost:3001/api/draft/grounded \
  -H "Content-Type: application/json" \
  -d '{"title":"Marriage","body":"I just got married, can I add my spouse now?"}' | jq
```
Expect a `draft` containing a verified `[policy:N]` citation. An off-topic body
(e.g. "reset my password") should return `"abstained": true`.

**Retrieval only** (from `rag/`):
```bash
cd rag && set -a; source .env; set +a
npx tsx scripts/test-retrieve.ts "Can a part-time employee enroll?"
```

---

## 6. Routine operations

### Re-ingest after a policy doc changes
```bash
psql "$DATABASE_URL" -c "TRUNCATE policy_chunks RESTART IDENTITY;"
cd rag && set -a; source .env; set +a && npm run ingest && cd ..
```
(Truncate avoids duplicate rows — ingest appends.)

### Add resolved-ticket precedents
Backfill from your approved drafts, or append to `rag/docs/resolved-tickets.json`
and re-ingest. De-dupe first if re-running on the same file.

### Switch draft provider
Change `LLM_PROVIDER` (or `LLM_PROVIDER_DRAFT`) and restart the app. The grounded
route honors it because it calls `providers.draft.draftGrounded`. No data change.

### Switch embedding model
Dimensions must match across model, `EMBED_DIM`, and the schema `vector(...)`.
Update all three, then truncate and re-ingest:
```bash
psql "$DATABASE_URL" -c "TRUNCATE policy_chunks, resolved_tickets RESTART IDENTITY;"
cd rag && npm run ingest && cd ..
```

---

## 7. Monitoring

`retrieval_log` is the operational source of truth.

```sql
-- abstention rate, last 24h
SELECT count(*) AS total,
       count(*) FILTER (WHERE abstained IS NOT NULL) AS abstained
FROM retrieval_log WHERE created_at > now() - interval '24 hours';

-- retrieval strength distribution, last 7d
SELECT round(top_similarity::numeric,1) AS bucket, count(*)
FROM retrieval_log WHERE created_at > now() - interval '7 days'
GROUP BY bucket ORDER BY bucket;

-- drafts that cited nothing despite retrieving policy (possible regression)
SELECT count(*) FROM retrieval_log
WHERE abstained IS NULL AND cited_policy_ids = '[]' AND retrieved_policy_ids <> '[]';
```

Alert on relative jumps, not absolute numbers.

---

## 8. Troubleshooting (failure modes seen during setup)

| Symptom | Cause | Fix |
|---|---|---|
| `socket "/tmp/.s.PGSQL.5432" ... No such file` | `$DATABASE_URL` empty in shell | `set -a; source .env; set +a`; `echo "$DATABASE_URL"` |
| `role "triage" does not exist` / `connection refused` on 5432 | Hitting wrong Postgres; URL on 5432 not 5433 | Use `:5433`; confirm `docker port triage-postgres 5432` |
| `no public port '5432' published` | Container recreated without port mapping | `docker compose up -d --force-recreate postgres` |
| `extension "vector" is not available` | Stock `postgres` image lacks pgvector | Use `pgvector/pgvector:pg16` image |
| Container stuck `Restarting`; logs mention data-dir/mount | `pg18` image data-directory layout change | Pin image to `pg16`; `down -v` + `up` (data already empty) |
| `Container name "/triage-postgres" already in use` | Stopped container exists | `docker start triage-postgres` (not `compose up`) |
| `Top-level await ... not supported with "cjs"` | rag/ is CommonJS; script used top-level await | Wrap logic in `async function main(){…}; main().catch(...)` |
| `Cannot find module .../scripts/scripts/x.ts` | Ran from inside `scripts/` | Run from `rag/`, or drop the `scripts/` prefix |
| `zsh: quote>` hangs | Pasted a `#` comment containing an apostrophe | Ctrl+C; don't paste trailing `# …` notes into zsh |
| Every case abstains | Query/ingest embedding models differ, or threshold too high | Same model both sides; re-ingest; lower `MIN_SIMILARITY` |
| Duplicate retrieval hits | Ingest ran twice (it appends) | `TRUNCATE … RESTART IDENTITY;` then re-ingest once |
| Grounded route ignores `LLM_PROVIDER` | `draftGrounded` hardcoded a provider | Ensure it calls `providers.draft.draftGrounded`, not a direct fetch |
| `Ollama embed failed ECONNREFUSED` | Ollama not running | `ollama serve`; `ollama pull nomic-embed-text` |

---

## 9. Rollback / disable

The grounded route is additive. To disable without removing code:
- Stop calling `/api/draft/grounded` from the UI (use the original `/api/draft`), or
- Set `MIN_SIMILARITY=1.0` to force universal abstention while investigating, or
- Comment out the route registration in `app.js`.

The RAG tables are inert when not queried; leave them in place. Full teardown:
`DROP TABLE policy_chunks, resolved_tickets, retrieval_log;` (keep the extension).

---

## 10. Recovery

The database is reproducible: app schema from migrations + `db:seed`, RAG corpus
from `rag/docs/` via ingest. A clean rebuild is `npm run db:reset` (app) followed
by the §3.4–3.5 pgvector + RAG steps. Only `retrieval_log` is non-reproducible —
include it in DB backups if its history matters.

---

## 11. Environment reference

| Var | Default | Used by | Notes |
|---|---|---|---|
| `DATABASE_URL` | — | app + rag | **port 5433**; same value both `.env` files |
| `PORT` | 3001 | app | server port |
| `LLM_PROVIDER` | — | app | `anthropic` / `ollama`; or `LLM_PROVIDER_TRIAGE` / `_DRAFT` |
| `ANTHROPIC_API_KEY` | — | app | reuse your existing key |
| `OLLAMA_URL` | `http://localhost:11434` | embed + ollama draft | |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | embed | must match what ingest used |
| `POLICY_K` | 5 | retrieval | policy passages retrieved |
| `PRECEDENT_K` | 3 | retrieval | precedents retrieved |
| `MIN_SIMILARITY` | 0.45 | retrieval | cosine floor + abstention threshold |
| `DRAFT_MODEL` | per adapter | draft | model the draft provider uses |
