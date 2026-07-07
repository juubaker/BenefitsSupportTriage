# Benefits Support Triage — MCP Server

Exposes the RAG-backed Benefits Support Triage Agent as a standard [MCP](https://modelcontextprotocol.io)
server: any MCP-compatible host (Claude Desktop, Claude Code, Cursor) can search the
policy corpus, find precedent tickets, run full triage, and pull live RAG eval
scores — without touching the app's own UI.

This exists to answer one interview question well: **"How do you know your RAG
is any good?"** The answer isn't a claim — it's a live tool call to
`get_eval_metrics`, backed by a DeepEval golden dataset, callable from inside
Claude Desktop in front of an interviewer.

## Architecture

```
                    ┌─────────────────────────┐
                    │   MCP Host              │
                    │ (Claude Desktop / Code)  │
                    └────────────┬────────────┘
                                 │ JSON-RPC / stdio
                    ┌────────────▼────────────┐
                    │  Benefits Triage         │
                    │  MCP Server (this repo)  │
                    ├──────────────────────────┤
                    │ Tools:                   │
                    │  search_policies         │
                    │  find_similar_tickets    │
                    │  triage_ticket           │
                    │  get_eval_metrics        │
                    │ Resources:               │
                    │  policy://chunk/*        │
                    │  ticket://*              │
                    │  eval://latest           │
                    └────────────┬────────────┘
                                 │ Drizzle (shared client)
                    ┌────────────▼────────────┐
                    │  Postgres + pgvector     │
                    │  policy_chunks           │
                    │  resolved_tickets        │
                    └──────────────────────────┘
                                 ▲
                    ┌────────────┴────────────┐
                    │  Ollama (nomic-embed-text)│
                    │  DeepEval sidecar (pytest) │
                    │  Anthropic API (triage LLM)│
                    └──────────────────────────┘
```

The MCP server is a thin interface layer. It shares the same Drizzle client
and pgvector tables as the existing Express API — no duplicated retrieval or
business logic, no drift between "the app" and "the MCP server."

## What's implemented

| Tool | Backs onto |
|---|---|
| `search_policies` | pgvector cosine search over `policy_chunks` |
| `find_similar_tickets` | pgvector cosine search over `resolved_tickets` |
| `triage_ticket` | full agent loop: retrieval + Claude reasoning + structured output |
| `get_eval_metrics` | reads latest DeepEval sidecar JSON report |

| Resource URI | Returns |
|---|---|
| `policy://chunk/{id}` | Raw text of a specific policy chunk |
| `ticket://{id}` | Full resolved ticket record |
| `ticket://{id}/resolution` | Just the resolution summary |
| `eval://latest` | Latest DeepEval run, all four metrics |

One prompt (`triage_summary_for_manager`) is included to demonstrate all
three MCP primitives, not just tools.

## Setup

```bash
git clone <this-repo>
cd benefits-support-triage-mcp
npm install
cp .env.example .env   # set DATABASE_URL, OLLAMA_URL, EVAL_REPORT_PATH
npm run build
```

Wire up the schema and business logic to your real implementation:

1. `src/db.ts` — point at your existing `rag/db/client.ts` and `rag/db/schema.ts`
2. `src/embeddings.ts` — point at your existing Ollama embed wrapper
3. `src/triage.ts` — extract your existing Express route's agent-loop logic here
4. `src/eval.ts` — point `EVAL_REPORT_PATH` at your DeepEval sidecar's output

Everywhere a change is needed is marked `// SCHEMA:` or `SCHEMA` in the file
header comments.

## Running it

**Standalone (for local dev):**

```bash
npm run dev
```

**Inspect without an LLM in the loop (do this first, always):**

```bash
npm run build
npm run inspect
```

Opens a web UI at the printed URL. List tools, call `search_policies` with a
real query, confirm you get ranked results with similarity scores before
wiring this into any host.

**Claude Desktop:**

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "benefits-support-triage": {
      "command": "node",
      "args": ["/absolute/path/to/benefits-support-triage-mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgres://postgres:postgres@localhost:5433/benefits_triage",
        "OLLAMA_URL": "http://localhost:11434"
      }
    }
  }
}
```

Restart Claude Desktop. The four tools appear under the hammer icon.

**Claude Code:**

```bash
claude mcp add benefits-support-triage -- node /absolute/path/to/dist/index.js
```

## Demo script (for interviews)

Structured as a 5-minute walkthrough. Each step has a specific point to make
— don't just click through it.

### 1. Open with the problem (30 sec)

"Most RAG demos show you an answer and ask you to trust it. I wanted a demo
where the retrieval quality is checkable, live, by anyone — not just visible
in my app's UI."

### 2. Show retrieval in isolation (1 min)

In Claude Desktop:

> "Search the benefits policy corpus for HSA contribution limits for family
> coverage."

Claude calls `search_policies`. Point out the response includes
**similarity scores and chunk IDs**, not just text — the retrieval is
auditable, not a black box.

### 3. Show precedent search (1 min)

> "Have we seen tickets like 'can I change my HSA contribution mid-year' before?"

Claude calls `find_similar_tickets`. This demonstrates the dual-corpus design
— policy language and operational precedent are separate retrieval paths
that a triage decision should draw on both.

### 4. Run full triage (1 min)

> "Triage this ticket: 'My spouse just lost their job and I need to change my
> health plan mid-year, is that allowed?'"

Claude calls `triage_ticket`. Show the output includes
`retrieval_evidence` (which chunks/tickets it actually used) and
`requires_human_review` — the system is honest about its own confidence
rather than always sounding certain.

### 5. The payoff — eval metrics on demand (1.5 min)

> "How do you know this retrieval is actually good?"

> "Show me the latest RAG eval metrics for this system."

Claude calls `get_eval_metrics`, returning contextual precision/recall,
faithfulness, and answer relevancy from your 15-case DeepEval golden dataset.
This is the answer to the RAG-evaluation question that doesn't rely on you
asserting it — it's a live, re-runnable number.

### Close

"The MCP server is what let me expose this outside my own UI — the tools are
the same code path as the production API, so this isn't a separate demo
system, it's the real thing wrapped in a standard interface."

## Why this is a stronger artifact than a UI screenshot

- **Portability**: works in any MCP host, not just your custom frontend
- **Auditability**: every tool response carries retrieval provenance (IDs,
  similarity scores) — nothing is asserted without evidence attached
- **Honesty**: `requires_human_review` and eval metrics mean the system
  reports its own limits instead of always sounding confident
- **No duplicated logic**: same Drizzle client and triage pipeline as the
  production Express API — this isn't a toy reimplementation

## Roadmap (mention if asked "what's next")

- Swap stdio for Streamable HTTP + OAuth 2.1 to make this a remote server
  other teams could point their own MCP hosts at
- Add a `flag_policy_gap` tool that lets the triage output feed back into a
  queue for policy-writing review when `requires_human_review` fires often
  for the same category
- Wrap NexusAgent as an MCP *host* so its policy engine and audit logging
  govern calls into this server (and other third-party MCP servers) —
  the enterprise-governance story
