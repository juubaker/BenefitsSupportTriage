"""What similarity floor does the resolved_tickets corpus actually support?

The 0.65 floor came from the policy sweep in retrieval_eval.py, which only
ever measured policy_chunks. Applied to resolved_tickets it is too high:
find_similar_tickets returned nothing even for a ticket whose precedent is
plainly in the corpus ("spouse job loss" against "My husband was laid off and
we're losing his employer coverage"). Short query against long case text, and
different vocabulary for the same event, puts a genuine match below 0.65.

No golden case cites an R- id, so there is no labelled ground truth here and
hit@1/MRR cannot be computed. What can be measured is the score distribution:
for every golden case, how similar is the best resolved ticket, and does the
top match look relevant. That is enough to choose a floor deliberately rather
than inherit one from a different corpus.

    DATABASE_URL=... python ticket_floor.py
    DATABASE_URL=... python ticket_floor.py --show 12
"""

from __future__ import annotations

import argparse
import json
import math
import os
import urllib.request

import psycopg

from cases import load_cases

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://triage:triage@localhost:5433/triage")
THRESHOLDS = [round(0.40 + 0.025 * i, 3) for i in range(17)]  # 0.400 .. 0.800
POLICY_FLOOR = 0.65  # what the services use for both corpora today


def embed(text: str) -> list[float]:
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/embeddings",
        data=json.dumps({"model": EMBED_MODEL, "prompt": text}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["embedding"]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def load_tickets() -> list[tuple[str, str, str, list[float]]]:
    """Returns (cited_id, category, case_text, embedding).

    cited_id is ticket_key when the row has one, matching what the agent
    actually cites. Falling back to R-<serial id> mirrors the agent, and is
    why the ids in this script's output used to move between runs: the ingest
    deleted every row, so the sequence advanced each time.
    """
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            "select id, ticket_key, category, case_text, embedding::text "
            "from resolved_tickets order by coalesce(ticket_key, id::text)"
        ).fetchall()
    return [(k or f"R-{i}", c, t, json.loads(e)) for i, k, c, t, e in rows]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--show", type=int, default=0, help="print the top match for the first N cases")
    args = ap.parse_args()

    tickets = load_tickets()
    if not tickets:
        raise SystemExit("resolved_tickets is empty — run the rag ingest first.")
    cases = load_cases()
    print(f"{len(cases)} cases, {len(tickets)} resolved tickets\n")

    tops: list[tuple[str, float, int, str]] = []
    for case in cases:
        q = embed(f"{case.subject}\n{case.body}")
        scored = [(cosine(q, vec), tid, cat, text) for tid, cat, text, vec in tickets]
        scored.sort(reverse=True)
        best, tid, cat, text = scored[0]
        tops.append((case.id, best, tid, f"[{cat}] {text[:46]}"))

    scores = sorted(s for _, s, _, _ in tops)
    n = len(scores)
    print("top-match score distribution across all cases")
    for label, v in [
        ("min", scores[0]),
        ("p25", scores[n // 4]),
        ("median", scores[n // 2]),
        ("p75", scores[3 * n // 4]),
        ("max", scores[-1]),
    ]:
        print(f"  {label:>6}: {v:.4f}")

    print("\nthreshold  cases with >=1 match")
    for t in THRESHOLDS:
        hit = sum(1 for s in scores if s >= t)
        mark = "  <- policy floor" if t == POLICY_FLOOR else ""
        print(f"  {t:.3f}    {hit:>2}/{n}  ({hit / n:.0%}){mark}")

    print(
        "\nA floor is a judgement, not an optimum: too low and the model is handed\n"
        "irrelevant precedent as evidence, too high and the tool is dead weight.\n"
        "Read the top matches below and pick the point where they stop being useful."
    )

    if args.show:
        print(f"\ntop match per case (first {args.show})")
        for cid, best, tid, snippet in tops[: args.show]:
            print(f"  {cid:<16} {best:.4f}  {tid:<38} {snippet}")


if __name__ == "__main__":
    main()
