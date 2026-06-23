# RUNBOOK — Benefits Support Triage Agent (RAG layer)

Operational guide for running, maintaining, and recovering the retrieval layer.
This is the "how do I operate it / what do I do when it breaks" document.
For *why it's built this way*, see the tech spec; for *what each file is*, see the README.

- **Service:** RAG grounding for the triage agent (precedent + policy retrieval, citation verification, abstention)
- **Stores:** PostgreSQL + pgvector — tables `policy_chunks`, `resolved_tickets`, `retrieval_log`
- **External deps:** Anthropic API (drafting), embedding backend (Ollama local *or* Voyage hosted)

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| PostgreSQL 14+ with `pgvector` | Extension must be installable on the server (Postgres.app, Homebrew `pgvector`, Supabase, RDS with the extension enabled) |
| Node 18+ | For `tsx` / `drizzle-kit` |
| Anthropic API key | `ANTHROPIC_API_KEY` |
| Embedding backend | Ollama running locally (default) **or** `VOYAGE_API_KEY` set |

Confirm `.env` is populated from `.env.example` before doing anything else.

---

## 2. First-time setup (run once)

```bash
cp .env.example .env            # then fill in DATABASE_URL + ANTHROPIC_API_KEY
npm install drizzle-orm pg @anthropic-ai/sdk
npm install -D drizzle-kit tsx typescript @types/pg @types/node

# 1. enable the extension (MUST run before any vector column exists)
psql "$DATABASE_URL" -f db/0000_enable_pgvector.sql

# 2. create tables + HNSW indexes
npx drizzle-kit generate
npx drizzle-kit migrate

# 3. pull the local embedding model (skip if EMBED_PROVIDER=voyage)
ollama pull nomic-embed-text

# 4. load the corpora
npx tsx scripts/ingest.ts
```

**Verify the setup landed:**

```bash
psql "$DATABASE_URL" -c "\dx vector"                       # extension present
psql "$DATABASE_URL" -c "SELECT count(*) FROM policy_chunks;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM resolved_tickets;"
```

A non-zero count in both tables means retrieval has something to return.

---

## 3. Routine operations

### 3.1 Re-ingest after a policy document changes

The policy corpus is a snapshot. When a benefits guide changes, the old chunks
are stale and must be replaced.

```bash
# clear the policy corpus (precedents are untouched)
psql "$DATABASE_URL" -c "TRUNCATE policy_chunks RESTART IDENTITY;"

# drop the updated docs into docs/policies/ then re-run
npx tsx scripts/ingest.ts
```

> Truncating resets ids. If anything external pins to `policy_chunks.id`, prefer
> a delete-by-`doc_title` of just the changed document instead of a full truncate.

### 3.2 Add resolved-ticket precedents

In production, precedents should come from your approved-cases table, not the JSON
file. To backfill from approved cases, embed each `case_text` and insert into
`resolved_tickets` (the ingest script's `ingestTickets()` is the template). For a
quick manual top-up, append to `docs/resolved-tickets.json` and re-run ingest —
note this **appends**, so de-dupe first if re-running on the same file.

### 3.3 Switch embedding provider or model

Embedding dimensions must match across **model → `EMBED_DIM` → schema `vector(...)`**.
Changing the model is a full re-embed, not a config flip.

```bash
# 1. edit lib/config.ts: EMBED_DIM (e.g. 768 -> 1024)
# 2. edit db/schema.ts vector dimension to match
# 3. set EMBED_PROVIDER / model env vars
npx drizzle-kit generate && npx drizzle-kit migrate   # alters the vector columns
psql "$DATABASE_URL" -c "TRUNCATE policy_chunks, resolved_tickets RESTART IDENTITY;"
npx tsx scripts/ingest.ts                              # re-embed everything
```

### 3.4 Rotate the Anthropic / Voyage key

Update the value in `.env` (and your deployment secret store), then restart the
app process. No data migration needed — keys are read at call time.

---

## 4. Health checks & monitoring

`retrieval_log` is the operational source of truth. Run these periodically.

**Abstention rate (last 24h)** — a sudden spike usually means retrieval broke:

```sql
SELECT
  count(*)                                         AS total,
  count(*) FILTER (WHERE abstained IS NOT NULL)    AS abstained,
  round(100.0 * count(*) FILTER (WHERE abstained IS NOT NULL) / count(*), 1) AS pct
FROM retrieval_log
WHERE created_at > now() - interval '24 hours';
```

**Retrieval strength distribution** — are matches healthy or borderline?

```sql
SELECT round(top_similarity::numeric, 1) AS bucket, count(*)
FROM retrieval_log
WHERE created_at > now() - interval '7 days'
GROUP BY bucket ORDER BY bucket;
```

**Citation health** — cases that retrieved policy but cited nothing verified
(possible prompt/verification regression):

```sql
SELECT count(*)
FROM retrieval_log
WHERE abstained IS NULL
  AND cited_policy_ids = '[]'
  AND retrieved_policy_ids <> '[]';
```

**Baselines to watch:** abstention rate stable week-over-week, `top_similarity`
mostly above `MIN_SIMILARITY`, near-zero unverified-citation rate. Alert on a
relative jump rather than an absolute number.

---

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `type "vector" does not exist` on migrate | Extension not enabled | Run `db/0000_enable_pgvector.sql` **before** migrate |
| `extension "vector" is not available` | pgvector not installed on the server | Install pgvector (Homebrew/apt) or enable it on the managed instance |
| `Embedding dimension mismatch: model returned N, config EMBED_DIM is M` | Model swapped without updating config + schema | Align `EMBED_DIM`, schema `vector(...)`, and re-ingest (§3.3) |
| `Ollama embed failed (ECONNREFUSED)` | Ollama not running / wrong `OLLAMA_URL` | `ollama serve`; confirm `OLLAMA_URL`; `ollama pull nomic-embed-text` |
| Retrieval returns nothing for valid cases | Corpus empty, or `MIN_SIMILARITY` too high | Check row counts (§2); lower `MIN_SIMILARITY`; confirm ingest ran |
| **Every** case abstains | Embedding model mismatch between ingest and query, or threshold too high | Verify same model embedded the corpus and serves queries; re-ingest if changed; review §5.1 |
| Drafts cite policy that doesn't fit | Retrieval pulling wrong chunks (low precision) | Tune `POLICY_K` down, raise `MIN_SIMILARITY`, add reranking (see spec §8) |
| Citations always `verified: false` | `[policy:id]` markers stripped/reformatted, or id namespace drift | Inspect a raw draft; confirm the system prompt's citation format; check ids match retrieved set |
| Slow retrieval as corpus grows | HNSW index missing/not used | Confirm the `*_embedding_idx` indexes exist; `ANALYZE` the tables |
| `ANTHROPIC_API_KEY` errors | Missing/expired key | Set key in `.env`, restart process |

### 5.1 Deep-dive: "the agent abstains on everything"

This is almost always an **embedding mismatch** between the vectors stored at
ingest time and the vectors generated at query time. Cosine similarity between
embeddings from two different models is effectively random, so every score falls
below `MIN_SIMILARITY` and the abstention gate fires.

```bash
# what model is configured now?
grep -E "EMBED_PROVIDER|OLLAMA_EMBED_MODEL|VOYAGE_EMBED_MODEL" .env lib/config.ts
```

If the configured model differs from the one that populated the corpus, re-ingest
under the current model (§3.3). If they match, the threshold is simply too high —
lower `MIN_SIMILARITY` incrementally (e.g. 0.45 → 0.35) and re-check the
similarity distribution query in §4.

---

## 6. Tuning playbook

Change **one knob at a time** and re-check against the eval set (spec §11), not vibes.

| Goal | Knob | Direction |
|---|---|---|
| Fewer irrelevant passages in the prompt | `POLICY_K` | decrease |
| More grounding context for complex cases | `POLICY_K` | increase |
| Stricter grounding (reject weak matches) | `MIN_SIMILARITY` | increase |
| Fewer false abstentions | `MIN_SIMILARITY` | decrease |
| Better tone matching in drafts | `PRECEDENT_K` | increase (watch token cost) |

---

## 7. Disable / roll back RAG

The RAG layer is additive and reversible. To revert the agent to system-prompt-only
drafting without removing anything:

1. Route the draft call back to the pre-RAG code path (skip `draftResponse()` /
   `retrieve()`), or
2. Set `MIN_SIMILARITY` to `1.0` to force universal abstention so no grounded
   drafts are produced while you investigate, or
3. Feature-flag the retrieval call at the Express route level.

The corpus tables can be left in place — they're inert when not queried. A full
teardown is `DROP TABLE policy_chunks, resolved_tickets, retrieval_log;` (the
`vector` extension can stay).

---

## 8. Backup & recovery

| Data | Backup approach | Recovery |
|---|---|---|
| `policy_chunks`, `resolved_tickets` | Covered by normal Postgres backups, but **fully reproducible** from source docs | Re-run ingest (§2 step 4) — embeddings are deterministic per model |
| `resolved_tickets` (production source) | Lives in the approved-cases table | Re-embed from approved cases |
| `retrieval_log` | Include in DB backup (audit + eval seed; not reproducible) | Restore from DB backup; loss = lost audit history only |

Because both corpora are re-derivable from the source documents, the disaster-recovery
story is "restore the docs, re-run ingest" — the vector data is never the
irreplaceable copy.

---

## 9. Incident quick-reference

| Incident | First move |
|---|---|
| Ingest job failed partway | Truncate the affected table, re-run ingest (it's idempotent on a clean table) |
| Drafts suddenly low-quality after a deploy | Check whether the embedding model or `MIN_SIMILARITY` changed; compare similarity distribution (§4) to last week |
| Abstention spike alert | Run §4 abstention query, then §5.1 deep-dive |
| Reviewer reports a fabricated citation | Pull the `retrieval_log` row for that case; confirm `cited_policy_ids` ⊆ `retrieved_policy_ids`; if the verifier passed it wrongly, inspect citation parsing |
| pgvector / DB unavailable | Drafting should fail closed to abstention (human handles the case); restore DB, no re-ingest needed if backups are current |

---

## 10. Escalation notes

- A failure in this layer degrades gracefully: when retrieval or the DB is down,
  the safe behavior is **abstain and route to a human**, not draft ungrounded.
- The agent never sends to employees on its own — a reviewer is always between the
  draft and the recipient, so a bad draft is contained at review, not in production.
- Keep `retrieval_log` retention long enough to cover your eval and audit needs;
  it is the only non-reproducible data in the system.
