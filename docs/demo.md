# Walkthrough

A guided tour of the system in about ten minutes. Each step shows one
property of the design and what to look for when it works. It assumes the
[quick start](../README.md#quick-start) is done: Postgres up, corpora ingested,
Ollama running, and the MCP server registered with Claude Desktop.

The theme throughout: every answer carries its evidence, and quality is
measured rather than asserted. Steps 1–3 use the MCP server; steps 4–6 use the
v2 agent and eval harness from the command line.

## 1. Retrieval is inspectable

In Claude Desktop:

> Search the benefits policy corpus for HSA contribution limits for family coverage.

Claude calls `search_policies`. The result is a ranked list of policy chunks,
each with its id and cosine similarity score, not just a block of text.

**What to look for:** scores falling off after the first few results, and chunk
ids you can open directly through the `policy://chunk/{id}` resource. Weak
matches below the similarity floor are dropped rather than passed along as if
they were relevant.

## 2. Two corpora, two kinds of evidence

> Have we seen tickets like "can I change my HSA contribution mid-year" before?

Claude calls `find_similar_tickets`, which searches `resolved_tickets` instead
of policy documents.

**What to look for:** policy says what the rules are; precedent says how
comparable cases were actually resolved. A good triage decision draws on both,
which is why they are separate retrieval paths with separate results.

## 3. Triage that reports its own confidence

> Triage this ticket: "My spouse just lost their job and I need to change my
> health plan mid-year. Is that allowed?"

Claude calls `triage_ticket`. The response includes a category and priority,
`retrieval_evidence` listing the chunks and tickets that were used, and
`requires_human_review`, which turns on when the best policy match is weak or
the model's confidence is low.

**What to look for:** the system flags its own uncertainty instead of always
sounding certain. Try a question the corpus doesn't cover and watch the review
flag turn on.

## 4. The agent loop, step by step

The MCP `triage_ticket` tool is a single retrieval-then-classify pass. The v2
agent does the same job as a bounded tool-use loop: it decides what to search,
refines its queries, and must finish by calling a terminal tool. Run one
ticket through it:

```bash
cd agent
npm run smoke -- --fake     # scripted model: verifies loop mechanics, no LLM
npm run smoke               # real model on local Ollama
```

The smoke script uses a small in-memory corpus, so this step is about how the
loop behaves, not about retrieval quality. The output streams each step and
ends with a run summary and checks:

```
steps          : 3  [search_policies → search_policies+find_similar_tickets → triage_ticket]
Checks
  PASS  terminal state is completed
  PASS  every step persisted before finish
  PASS  ledger rows match steps
  PASS  searched policies before triaging
```

**What to look for:** the example ticket touches two topics, a qualifying
life event and COBRA, so the agent searches twice with refined queries before
deciding. Every step and its token usage is recorded before the run finishes,
so a run can be replayed and scored later. The loop is bounded by a step
limit and a token budget, and ends in a named terminal state (completed,
escalated, budget exhausted, aborted) rather than trailing off in prose.
Running it again with `--provider anthropic` shows the same mechanics across
providers.

## 5. The tests behind it

```bash
cd agent && npx vitest run
```

**What to look for:** the loop, budgeter, providers, tracing and graph layer
are all tested with a scripted provider and in-memory fakes, so the suite runs
in a couple of seconds with no model or database. `tracing.test.ts` asserts
the span tree a run produces: one span per run, a child per loop step, and a
child per tool call carrying token usage. `triage-services.test.ts`
checks the pgvector-backed tools against a fake database, including the
similarity floor and the cap on how many results the model can request.

## 6. How quality is measured

```bash
cd evals && python -m pytest test_eval.py -q
```

The suite is built around 42 golden cases across six buckets:

| Bucket | Tests |
|---|---|
| base | single-topic questions with known grounding chunks |
| multi-hop | tickets that need several refined searches |
| adversarial | prompt injection and misleading phrasing |
| out of scope | questions the agent should escalate, not answer |
| budget | runs that must finish cleanly under a tight token budget |
| graph | multi-entity questions for the optional graph layer |

Two kinds of metric run over recorded agent runs. Deterministic trajectory
metrics check things like whether the agent searched before deciding and
whether every citation appeared in an earlier tool result. A judge-model pass
scores answer faithfulness and reasoning quality. The command above runs the
harness's own self-tests, which check the metrics, loaders and scorecard
against synthetic runs.

**What to look for:** each metric points at a specific layer when it fails:
faithfulness at generation, contextual recall at retrieval, contextual
precision at ranking, and hallucinated citations at the loop's grounding
rules.

## Known gaps

This walkthrough reflects the system as it stands:

- The agent isn't yet mounted behind the Express API, so it runs from the
  smoke script rather than from the reviewer UI, and the eval suite can't yet
  score live runs end to end. Traced runs in Jaeger follow from the same change.
- `triage_ticket` over MCP uses the single-pass pipeline, not the agent loop.
- `get_eval_metrics` returns a placeholder until the eval runner's scorecard
  and the report format it reads are reconciled.

All are tracked in the README's [status](../README.md#status) section.

## Where this goes next

- Mount the agent behind the API, so the UI, MCP and evals share one code path
  and the CI eval gates can switch on.
- Serve the MCP server over Streamable HTTP with OAuth 2.1, so other teams can
  connect their own MCP hosts to it.
- A `flag_policy_gap` tool that queues a category for policy-writing review
  when `requires_human_review` fires often for it.
