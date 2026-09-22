# Benefits Support Triage

An AI triage system for Oracle HCM Cloud Benefits support posts. It classifies
each post into a fixed Benefits taxonomy, retrieves the policy language and
previously resolved tickets that bear on it, and either surfaces an existing
answer or drafts a grounded, cited reply for a human reviewer. When the
evidence is weak or the question needs account data it can't see, it
escalates instead of guessing.

It is reachable through a three-pane reviewer UI backed by an Express API, and
through an [MCP](https://modelcontextprotocol.io) server that exposes retrieval
and triage to any MCP host (Claude Desktop, Claude Code, Cursor). A v2 agent,
built as a bounded tool-use loop with token budgeting and tracing, is being
brought in underneath both.

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
corpora as the v1 pipeline. It is exercised today through its smoke script;
its HTTP routes are defined but not yet mounted by the Express API. See
[agent/README.md](agent/README.md).

## Repository layout

| Path | What it is |
|---|---|
| `src/components`, `src/lib` | React + Vite reviewer UI |
| `server/` | Express API, v1 LLM provider registry, Drizzle repositories, grounded drafting |
| `src/index.ts` | MCP server: tools, resources, prompt |
| `agent/` | v2 agent: harness, loop, budgeter, registry, tracing, providers, graph layer, pgvector services. Own `package.json` |
| `rag/` | Corpus schema, chunking and ingest pipeline. Own `package.json` |
| `evals/` | Python eval sidecar: DeepEval answer metrics and trajectory metrics over 42 golden cases |
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

npm ci
npm run db:setup                    # starts Postgres (host port 5433), migrates, seeds
npm run dev                         # API on :3001, UI on the Vite URL it prints
```

Load the RAG corpora (policy chunks and resolved tickets) before using
grounded drafts or the MCP retrieval tools:

```bash
cd rag && npm ci
npm run db:enable && npm run db:migrate && npm run ingest
```

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
| `get_eval_metrics` | Reads an answer-quality report from `EVAL_REPORT_PATH`; returns a placeholder until one exists (see Status) |

Resources: `policy://chunk/{id}`, `ticket://{id}`, `ticket://{id}/resolution`,
`eval://latest`. Prompt: `triage_summary_for_manager`.

**Agent loop**

```bash
cd agent && npm ci --legacy-peer-deps
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
Traced runs will appear there once the agent route is mounted; until then the
span structure is covered by `agent/tests/tracing.test.ts`.

**Evals**

```bash
cd evals
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m pytest test_eval.py -q            # harness self-tests: metrics, loaders, scorecard
```

The golden set has 42 cases across base, multi-hop, adversarial, out-of-scope,
budget and graph buckets, scored by seven deterministic trajectory metrics and
a judge-model pass. The suite runner (`python -m run --suite smoke|nightly`)
needs a `wiring.py` (copy `wiring.example.py`) and an HTTP endpoint that runs
the agent, which is not mounted yet. See [evals/README.md](evals/README.md) and
[evals/V2_CONSOLIDATION.md](evals/V2_CONSOLIDATION.md).

## Tests

```bash
npm test                                          # web UI + Express API (Vitest)
cd agent && npx vitest run && npx tsc --noEmit    # agent package
```

The root suite skips its Postgres integration tests unless `TEST_DATABASE_URL`
is set. On every pull request, CI (`.github/workflows/eval.yml`) typechecks
and tests the agent package against Postgres with pgvector and runs the eval
harness self-tests. The eval smoke gate and nightly suite are defined in the
workflow but commented out until the agent endpoint they call is mounted.

## Status

In place: the v1 reviewer pipeline, the MCP server, and the v2 agent package
(harness, budgeter, tracing, graph layer) with its retrieval tools on the live
pgvector corpora, plus the eval harness and golden set. In progress:

- **Mounting the agent.** The agent's `/api/triage` route (SSE) is not yet
  mounted by the Express API, so the reviewer UI and the eval runner still
  can't call it. This also unblocks the CI eval gates.
- **Consolidating retrieval.** Embedding and vector search still exist in
  `server/rag`, `rag/lib` and `src/` alongside `agent/src/services`, which will
  replace them.
- **One schema.** `server/db`, `rag/db` and `agent/src/db` each have their own
  Drizzle schema and migrations, to be merged into one journal.
- **MCP triage on the agent loop.** `triage_ticket` runs a single
  retrieval-then-classify pass in `src/triage.ts` rather than the agent loop.
- **Eval metrics over MCP.** `get_eval_metrics` expects the v1 four-metric
  report format; the v2 runner writes a trajectory scorecard in a different
  format, so the tool returns a placeholder until the two are reconciled.
- **Citation keys.** Ingest does not yet populate `policy_chunks.chunk_key`, so
  real-retrieval citations won't match the golden set's chunk slugs.
- **Root tests in CI.** The web UI and Express suite runs locally but not yet
  in the workflow.

## Further reading

- [TECH_SPEC.md](TECH_SPEC.md): goals, taxonomy, design decisions
- [RUNBOOK.md](RUNBOOK.md): setup and operations
- [agent/README.md](agent/README.md): the agent package and its ports
- [evals/README.md](evals/README.md): evaluation approach
- [docs/demo.md](docs/demo.md): walkthrough

## License

See [LICENSE](LICENSE).
