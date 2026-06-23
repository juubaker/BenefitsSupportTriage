# Benefits Support Triage Agent — RAG layer

Adds retrieval-augmented grounding to the triage agent. The agent stops drafting
from the system prompt alone and instead grounds every case in (1) similar
previously-resolved tickets and (2) the relevant policy passages, with verified
citations and a confidence-based abstention path.

## Architecture

```
incoming case
   │
   ├─ embed(case)
   │
   ├─ retrieve precedents   ← resolved_tickets   (tone / resolution path)
   ├─ retrieve policy        ← policy_chunks       (facts / citations)
   │
   ├─ abstain if top similarity < threshold → route to human
   │
   ├─ Claude draft (cites [policy:id])
   ├─ verify every citation id ∈ retrieved set
   └─ log retrieval + citations → retrieval_log
```

Two corpora, deliberately separate: precedents ground *how to respond*, policy
grounds *what is true*. Keeping them apart lets you evaluate retrieval quality
on each independently.

## Files

| File | Purpose |
|------|---------|
| `db/schema.ts` | Drizzle schema: `resolved_tickets`, `policy_chunks`, `retrieval_log` with `vector` columns + HNSW indexes |
| `db/client.ts` | Drizzle + node-postgres client |
| `db/0000_enable_pgvector.sql` | Enables the `vector` extension (run once, first) |
| `lib/config.ts` | Embedding model/dim + retrieval knobs |
| `lib/embeddings.ts` | `embed()` / `embedBatch()` — Ollama (default) or Voyage |
| `lib/chunk.ts` | Heading-aware overlapping chunker |
| `lib/retrieval.ts` | `retrieve()` — dual pgvector cosine search |
| `lib/draft.ts` | Grounded prompt, citation parsing + verification, abstention, logging |
| `scripts/ingest.ts` | Chunk + embed policy docs and resolved tickets |
| `docs/` | Sample policy doc + resolved tickets so it runs out of the box |

## Setup

```bash
cp .env.example .env            # fill in DATABASE_URL + ANTHROPIC_API_KEY
npm install drizzle-orm pg @anthropic-ai/sdk
npm install -D drizzle-kit tsx typescript @types/pg @types/node

# 1. enable pgvector (once)
psql "$DATABASE_URL" -f db/0000_enable_pgvector.sql

# 2. create tables + indexes
npx drizzle-kit generate
npx drizzle-kit migrate

# 3. embeddings backend (local default)
ollama pull nomic-embed-text     # skip if using EMBED_PROVIDER=voyage

# 4. load the corpora
npx tsx scripts/ingest.ts
```

## Use

```ts
import { draftResponse } from "./lib/draft";

const result = await draftResponse(
  "I just got married — can I add my spouse now or wait for open enrollment?"
);

if (result.abstained) {
  // route to a human reviewer
} else {
  console.log(result.draft);        // text with [policy:id] markers
  console.log(result.citations);    // [{ id, verified }]
  console.log(result.retrieval);    // raw hits for the reviewer pane
}
```

## Wiring into the existing app

- The React **reviewer pane** now has `result.retrieval.policy` and
  `result.precedents` to display the evidence behind the draft, plus
  `result.citations[].verified` to flag any unverifiable citation in red.
- Source resolved tickets straight from your existing approved-cases table
  instead of `docs/resolved-tickets.json` — the embedding step is identical.
- `retrieval_log` is your audit trail and the seed for an eval set.

## Switching embedding models

Embedding dimensions must match across the model, `EMBED_DIM`, and the schema's
`vector(...)`. Changing models means updating all three and re-running ingest.
`nomic-embed-text` is 768; `voyage-3` and `mxbai-embed-large` are 1024.
