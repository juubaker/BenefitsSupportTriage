# Benefits Triage Agent — RAG Eval Suite (DeepEval sidecar)

A Python evaluation harness that treats the Benefits Support Triage Agent
(TypeScript/Express/pgvector) as a black box over HTTP and scores it with
DeepEval's four core RAG metrics against a 15-question golden dataset.

The Vitest suite (124 tests) answers "does the code work." This suite
answers a different question: "is the RAG system giving good answers, and
if not, is the problem retrieval or generation?"

## Layout

```
evals/
├── golden_dataset.json    15 benefits questions + ground-truth answers
├── api_client.py          HTTP client for the agent (2 adjustment points)
├── judge.py               Anthropic judge model config
├── test_rag_metrics.py    the deepeval/pytest suite (4 metrics x 15 cases)
├── run_evals.sh           runner with env + reachability checks
├── requirements.txt
└── .env.example
```

Drop this directory into the Benefits Triage Agent repo as `evals/`. Add
`evals/` to your Vitest exclude list (same pattern you already use for
`rag/node_modules`) so the two test worlds don't collide.

## Setup

```bash
cd evals
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in ANTHROPIC_API_KEY
```

## Wiring (two adjustments in api_client.py)

1. **Request shape** — the client POSTs `{"question": ...}` to
   `/api/triage`. Change payload/endpoint to match your route.
2. **Response shape** — the metrics need two things from your API:
   the final `answer` and the **retrieved chunk texts** in ranked order.
   If your endpoint doesn't currently return the chunks, add them
   (e.g. a `sources: [{text, score, corpus}]` array). Contextual
   Precision/Recall/Relevancy are meaningless without them.

Smoke test the wiring before running the suite:

```bash
python api_client.py "When is open enrollment?"
```

## Running

```bash
./run_evals.sh              # full suite
./run_evals.sh hsa-001      # one case, fast iteration
```

Cost/time note: 15 cases x 4 LLM-as-judge metrics ≈ 60+ judge calls per
run. Expect a few minutes and a nontrivial number of tokens. Use the
single-case mode while iterating.

## Reading failures

| Failing metric        | It's a...          | Look at                                             |
|-----------------------|--------------------|-----------------------------------------------------|
| Faithfulness          | generation problem | system prompt, grounding instructions, model choice |
| Contextual Precision  | ranking problem    | pgvector similarity ordering, re-ranking            |
| Contextual Recall     | retrieval problem  | chunking, nomic-embed-text quality, top-k too low   |
| Contextual Relevancy  | noise problem      | top-k too high, chunks too coarse                   |

## Before trusting the scores

The `expected_output` values in the golden dataset are written as
*plausible* benefits-policy answers. **Align them with your actual
policy_chunks corpus** — Contextual Recall compares retrieved chunks
against the expected output, so if the expected answer says "30 days"
and your policy docs say "31 days," you'll get false failures. Ten
minutes of reconciliation makes the whole suite trustworthy.

Also note DeepEval syncs test runs to Confident AI's cloud when you're
logged in (`deepeval login`). For local-only runs, don't log in and set
`DEEPEVAL_TELEMETRY_OPT_OUT=YES`.

## Interview framing (the reason this exists)

When asked "how do you evaluate a RAG system," this repo lets you answer
concretely instead of abstractly:

- **Separation of concerns**: retrieval quality (precision/recall/relevancy
  over retrieved chunks) vs. generation faithfulness (claims grounded in
  those chunks). One end-to-end "correctness" score can't tell you *which*
  layer to fix.
- **Golden dataset discipline**: curated ground truth per question, IDs on
  every case, thresholds ratcheted up over time rather than set at 1.0 —
  LLM-as-judge scores are stochastic, so brittle thresholds destroy trust
  in the suite.
- **Judge-model choice**: judge is configured separately from the agent's
  own model to reduce self-preference bias.
- **Two test suites, two jobs**: 124 Vitest tests gate code correctness in
  CI on every commit; this suite gates answer quality and runs on a
  schedule or before releases (it's slower and costs tokens).
