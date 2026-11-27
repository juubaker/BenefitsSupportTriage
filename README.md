# Benefits Support Triage

An AI triage system for Oracle HCM Cloud Benefits support posts. It classifies
each post into a fixed Benefits taxonomy, retrieves the policy language and
previously resolved tickets that bear on it, and either surfaces an existing
answer or drafts a grounded, cited reply for a human reviewer. When the
evidence is weak or the question needs account data it can't see, it
escalates instead of guessing.

It is reachable through a three-pane reviewer UI backed by an Express API, and
through an [MCP](https://modelcontextprotocol.io) server that exposes retrieval
and triage to any MCP host (Claude Desktop, Claude Code, Cursor). Underneath
both runs the v2 agent: a bounded tool-use loop with token budgeting, a per-run
tool registry and OpenTelemetry tracing, serving `POST /api/triage`.

On `claude-sonnet-4-6` it scores 39–40 of the 40 golden cases, with every
retrieval, loop and escalation metric at 1.0 and one case sitting on a
priority boundary. The scorecard records which provider actually generated the
tokens. See [Evaluation](#evaluation) for what that measures and what it does
not.

## Architecture

```
  React reviewer UI (src/)             MCP host (Claude Desktop / Code)
        │ HTTP                                  │ JSON-RPC over stdio
        ▼                                       ▼
  Express API (server/)                  MCP server (src/index.ts)
  v1 pipeline: classify, grounded        search, precedent search,
  draft, citation check, abstention      single-pass triage
        │                                       │
        └──────────────────┬────────────────────┘
                           ▼
          Postgres 16 + pgvector: policy_chunks, resolved_tickets
          Ollama: nomic-embed-text (768-dim) · Anthropic or Ollama for chat

  Agent (agent/), v2: harness, bounded tool loop, token budgeter,
  tool registry, OpenTelemetry tracing, optional graph layer
        ports: ProviderAdapter · TriageServices · RunStore
        adapters: Anthropic, Ollama · pgvector services · Drizzle run store
        (agent_runs, agent_steps, token_ledger, triage_results)

  Eval sidecar (evals/, Python): trajectory and answer metrics over golden cases
  Observability (observability/): OTel collector → Jaeger + Prometheus
```

The agent package depends only on interfaces for providers, retrieval and
persistence, so its loop, budgeting and tool dispatch are tested with fakes and
no database or model. Its retrieval tools run against the same pgvector
corpora as the v1 pipeline, behind similarity floors measured against the
golden set rather than chosen (see [Evaluation](#evaluation)). The Express API
mounts its SSE route, and the reviewer UI's agent panel streams from it. See
[agent/README.md](agent/README.md).

## Repository layout

| Path | What it is |
|---|---|
| `src/components`, `src/lib` | React + Vite reviewer UI |
| `server/` | Express API, v1 LLM provider registry, Drizzle repositories, grounded drafting |
| `src/index.ts` | MCP server: tools, resources, prompt |
| `agent/` | v2 agent: harness, loop, budgeter, registry, tracing, providers, graph layer, pgvector services. Own `package.json` |
| `rag/` | Corpus schema, chunking and ingest pipeline. Own `package.json` |
| `evals/` | Python eval sidecar: ten metrics over 40 golden cases, plus `policy_floor.py` and `ticket_floor.py`, which measure what the retrieval thresholds can actually reach |
| `observability/` | OTel collector, Jaeger and Prometheus compose stack |
| `docs/demo.md` | End-to-end walkthrough of the running system |

## Quick start

Prerequisites: Node 20+, Docker, and [Ollama](https://ollama.com) with the
embedding model and a tool-capable chat model pulled. An Anthropic API key is
optional; without one, everything runs locally on Ollama.

```bash
ollama pull nomic-embed-text
ollama pull qwen2.5                 # or llama3.1; must support tool calling

git clone https://github.com/juubaker/BenefitsSupportTriage.git
cd BenefitsSupportTriage
cp .env.example .env                # set ANTHROPIC_API_KEY if you have one

npm ci                              # root, agent/ and rag/ — one npm workspace
npm run db:setup                    # starts Postgres (host port 5433), migrates, seeds
npm run dev                         # API on :3001, UI on the Vite URL it prints
```

Load the RAG corpora (policy chunks and resolved tickets) before using
grounded drafts or the MCP retrieval tools:

```bash
npm run db:enable --workspace rag
npm run db:migrate --workspace rag
npm run ingest --workspace rag
```

The ingest reads `DATABASE_URL` from the root `.env`, and falls back to the
compose URL when there isn't one, so this works on a fresh clone.

Then apply the agent's tables:

```bash
psql "$DATABASE_URL" -f agent/src/db/migrations/0001_triage_results.sql
```

[RUNBOOK.md](RUNBOOK.md) covers setup, configuration and troubleshooting in
depth.

## Running the other pieces

**MCP server**

```bash
npm run mcp:build
npm run mcp:inspect                 # MCP Inspector: call the tools with no LLM in the loop
```

Register it with Claude Desktop in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "benefits-support-triage": {
      "command": "node",
      "args": ["/absolute/path/to/BenefitsSupportTriage/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://triage:triage@localhost:5433/triage",
        "OLLAMA_URL": "http://localhost:11434"
      }
    }
  }
}
```

Or with Claude Code: `claude mcp add benefits-support-triage -- node /absolute/path/to/dist/index.js`.

| Tool | Does |
|---|---|
| `search_policies` | pgvector cosine search over `policy_chunks`, with chunk ids and similarity scores |
| `find_similar_tickets` | pgvector cosine search over `resolved_tickets` |
| `triage_ticket` | Retrieval plus a structured classification, with `retrieval_evidence` and `requires_human_review` |
| `get_eval_metrics` | Reads the eval scorecard from `EVAL_REPORT_PATH`: case pass rate, per-metric and per-bucket rates, and failing cases. Says so plainly when no suite has run |

Resources: `policy://chunk/{id}`, `ticket://{id}`, `ticket://{id}/resolution`,
`eval://latest`. Prompt: `triage_summary_for_manager`.

**Agent loop**

The agent serves `POST /api/triage` (SSE) through the Express API once its
build is present; the reviewer UI's agent panel calls it. Build it, then start
the server as usual:

```bash
npm run agent:build                     # installed already by the root npm ci
npm run dev                             # agent mounted; AGENT_ENABLED=false to skip
```

Without the build, that route answers 503 explaining how to enable it, and the
rest of the API is unaffected. To run a single ticket through the loop from the
command line instead:

```bash
cd agent
npm run smoke -- --fake                 # scripted provider, no model: checks loop mechanics
npm run smoke                           # a real model on local Ollama
npm run smoke -- --provider anthropic   # same, on Claude (needs ANTHROPIC_API_KEY)
```

The smoke script runs one ticket against a small in-memory corpus and store,
so it tests the loop and provider mechanics rather than retrieval quality.

**Tracing**

```bash
docker compose -f observability/docker-compose.observability.yml up -d
```

The agent's tracer exports OTLP to `localhost:4318` (set
`OTEL_EXPORTER_OTLP_ENDPOINT` to change it), with Jaeger at
http://localhost:16686 and span metrics in Prometheus at http://localhost:9090.
Traced runs appear there with `AGENT_TRACING=true`; the span structure is also
covered by `agent/tests/tracing.test.ts`. Tracing is off by default, which used
to mean provider errors were discarded entirely — they are now logged and
streamed regardless.

**Evals**

```bash
cd evals
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m pytest test_eval.py -q            # harness self-tests: metrics, loaders, scorecard
```

The golden set has 40 cases across base (15), multi-hop (10), adversarial (5),
budget (5) and out-of-scope (5) buckets, scored by nine deterministic metrics
(seven on the trajectory, two on the decision) and one judge-model metric.

```bash
python run.py --suite smoke   --provider anthropic   # 10 cases, deterministic only
python run.py --suite nightly --provider anthropic   # all 40, judge included
```

The runner needs a `wiring.py` (copy `wiring.example.py`) and a running app;
`AGENT_APP_URL` must point at it, and the dev server listens on 3001. A
preflight checks the database, the corpus, the app, that the agent is mounted
and that a pinned provider exists, and exits 2 — distinct from the gate's 1 —
so a run that could not start is not mistaken for a regression. Progress goes
to stderr per case, leaving stdout a clean scorecard.

`--provider` pins every run, which also disables the harness's failover, so a
provider error fails the case instead of being scored on the fallback. See
[evals/README.md](evals/README.md) and
[evals/V2_CONSOLIDATION.md](evals/V2_CONSOLIDATION.md).

## Tests

Each line is run from the repository root:

```bash
npm test                                             # web UI + Express API: 149 passed, 6 skipped
npm test --workspace agent                           # agent package: 117 passed, 1 skipped
npm test --workspace rag                             # rag package: 4
(cd agent && npx tsc --noEmit)                       # agent typecheck
(cd evals && python -m pytest -q \
    --ignore=test_rag_metrics.py)                    # eval harness: 64
(cd agent && npm run provider-check)                 # one real call per configured provider
```

`test_rag_metrics.py` is excluded above because it needs `deepeval` installed;
drop the `--ignore` once `pip install -r evals/requirements.txt` has run.

`provider-check` is the fastest way to find out why a run is not using the
provider you expect: it prints the HTTP status and cause chain per provider,
which distinguishes a bad key (401) from a model the key cannot use (403), a
wrong model name (404), rate limiting (429) and an empty credit balance (400).

The root suite skips its Postgres integration tests unless `TEST_DATABASE_URL`
is set. On every pull request, CI (`.github/workflows/eval.yml`) typechecks
and tests the agent package against Postgres with pgvector and runs the eval
harness self-tests. The smoke and nightly eval jobs are written but commented
out: they drive real agent runs, so they need the app, Ollama and a migrated
database started in CI first.

## Evaluation

Full nightly suite on `claude-sonnet-4-6`, pinned with `--provider anthropic`.
Repeated runs land at 39–40 of 40 in about ten minutes:

| Metric | Rate |
|---|---|
| escalation_correctness | 1.00 |
| grounding_recall | 1.00 |
| loop_discipline | 1.00 |
| min_retrieval | 1.00 |
| retrieval_grounding | 1.00 |
| step_efficiency | 1.00 |
| token_budget_adherence | 1.00 |
| tool_choice_correctness | 1.00 |
| reasoning_quality (judge) | 1.00 |
| outcome_correctness | 0.975–1.00 |

Nine metrics hold at 1.0 across runs. `outcome_correctness` is the one that
moves, and it moves on a single case: **budget-03** asks which pharmacy tiers
three named drugs fall into, in a ticket framed as choosing a plan during open
enrollment. The tier question reads `low` and the framing reads `medium`; the
agent has answered each about half the time. The label is `medium` and is
correct — the fix belongs in how the rubric distinguishes a lookup from a
decision, not in the label.

So `--min-pass-rate 0.95` is the honest nightly gate. Smoke is
deterministic-only and holds 1.0.

**What the number rests on.** Every scorecard records the provider that
actually generated the tokens, read from `token_ledger` rather than from
`agent_runs.provider` — that column is set once at run start and is still
`anthropic` after a failover. The gate checks provenance before the pass rate,
because a suite that silently ran on the fallback has no pass rate worth
reporting. This matters here: for weeks every run failed over to local
llama3.1 on the first API call and nothing recorded why, so earlier scorecards
read as Claude results and were not.

**The retrieval thresholds are measured, not chosen.** `policy_floor.py` scores
each case against the `chunk_key`s its own `grounding_ids` require. At a 0.65
floor only 37 of 43 required chunks were reachable, and one miss was the
rank-1 chunk for its case; at 0.60 recall is 100%. `k` is not the lever — k=5,
8 and 10 all returned 86%. `ticket_floor.py` does the same for precedent,
where there is no labelled ground truth, by measuring the score distribution.
Both floors landed on 0.60 from independent measurements, and the comments in
`agent/src/services/pg-triage-services.ts` carry the numbers.

**What it does not show.** `reasoning_quality` comes from a local llama3.1
judge — a different model family from the worker, which is the constraint that
matters, and free, but not a strong judge. No golden case requires
`find_similar_tickets`, so the precedent path works and is cited in live runs
but is not measured by the gate. And a suite is 40 model calls plus 40 judge
calls over ten minutes: three separate runs degraded partway through before
provider retries were added, with cut streams surfacing as cases that reached
no decision. That is absorbed now, but the suite has no pacing, so a tighter
rate limit would show up the same way.

## Status

In place: the v1 reviewer pipeline, the MCP server, the v2 agent mounted at
`POST /api/triage` with measured retrieval floors, the eval harness with a
wired judge, and a passing nightly suite. Open:

- **Reproduce the 40/40.** One run so far. A second clean run makes it a
  baseline; the nightly gate probably belongs at 0.95 rather than 1.0, since
  the judge metric is stochastic. Smoke is deterministic and can hold 1.0.
- **CI eval gates.** The jobs exist but need the app, Ollama and a migrated
  database started in the workflow before they can be uncommented.
- **A stronger judge.** `judge_client.make_judge_call` is the single swap
  point; llama3.1 is the honest free option, not the best one.
- **Consolidating retrieval.** Embedding and vector search still exist in
  `server/rag`, `rag/lib` and `src/` alongside `agent/src/services`, which will
  replace them.
- **One schema.** `server/db`, `rag/db` and `agent/src/db` each have their own
  Drizzle schema and migrations, to be merged into one journal.
- **Retrieval tool overlap.** The MCP server's `search_policies` and
  `find_similar_tickets` keep their own SQL, which exposes `plan_type`
  filtering, resource URIs and corpus size that the agent's services do not.
  Worth reconciling, but not by dropping those fields.
- **Vitest 5 alignment** across both packages, which clears the remaining
  advisories and unblocks the npm workspace. Vitest 3 at the root against 4 in
  `agent/` is why the packages install separately.
- **`rag/db/client.ts`** reads `DATABASE_URL` with no dotenv loading and no
  default, so a fresh shell gets a confusing ECONNREFUSED on port 5432.
- **Root tests in CI.** The web UI and Express suite runs locally but not yet
  in the workflow.

## Further reading

- [TECH_SPEC.md](TECH_SPEC.md): goals, taxonomy, design decisions
- [RUNBOOK.md](RUNBOOK.md): setup and operations
- [agent/README.md](agent/README.md): the agent package and its ports
- [evals/README.md](evals/README.md): evaluation approach
- [docs/demo.md](docs/demo.md): walkthrough
- [RUNBOOK-integrated.md](RUNBOOK-integrated.md): troubleshooting table, including provider failover and scorecard provenance

## License

See [LICENSE](LICENSE).
