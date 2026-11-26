"""Can retrieval actually surface the evidence each golden case requires?

Unlike the resolved-ticket corpus, the golden cases DO carry labelled ground
truth for policy chunks: outcome.grounding_ids names the chunk_keys a correct
answer must cite. So this is a real recall measurement, not a distribution.

It exists because the first full Claude nightly failed base-06 with
grounding_recall 0.00 (missing chunk-401k-05) and then escalated — the
ungrounded-triage guard firing correctly on retrieval that returned nothing.
multihop-10 was the same thing partially: recall 0.50, missing chunk-fsa-07.
A floor of 0.65 was chosen from a policy-only sweep that never checked whether
each case's REQUIRED chunk clears it.

For every case and every expected chunk_key it reports the chunk's cosine
score against the case text and its rank among all chunks, then the share of
required chunks that would be returned at each candidate floor and k.

    DATABASE_URL=... python policy_floor.py
    DATABASE_URL=... python policy_floor.py --k 5 --floor 0.65
    DATABASE_URL=... python policy_floor.py --case base-06
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
FLOORS = [round(0.40 + 0.05 * i, 2) for i in range(9)]  # 0.40 .. 0.80


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


def load_chunks() -> list[tuple[str, str, list[float]]]:
    """(chunk_key, snippet, embedding). Rows without a chunk_key cannot be
    cited by a golden case, so they are skipped — but counted, because a
    required key missing from the corpus entirely is a different bug."""
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            "select chunk_key, chunk_text, embedding::text from policy_chunks order by id"
        ).fetchall()
    out = []
    missing_key = 0
    for key, text, emb in rows:
        if not key:
            missing_key += 1
            continue
        out.append((key, " ".join(text.split())[:60], json.loads(emb)))
    if missing_key:
        print(f"note: {missing_key} chunks have no chunk_key and can never be cited\n")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--k", type=int, default=5, help="k the agent requests (default 5)")
    ap.add_argument("--floor", type=float, default=0.65, help="the floor in use today")
    ap.add_argument("--case", default=None, help="only this case id")
    args = ap.parse_args()

    chunks = load_chunks()
    if not chunks:
        raise SystemExit("policy_chunks is empty or has no chunk_keys — run the rag ingest.")
    keys = {k for k, _s, _v in chunks}

    cases = [c for c in load_cases() if c.outcome.grounding_ids]
    if args.case:
        cases = [c for c in cases if c.id == args.case]
        if not cases:
            raise SystemExit(f"no case {args.case} with grounding_ids")

    print(f"{len(cases)} cases with expected grounding ids, {len(chunks)} citable chunks\n")

    # (case_id, expected_key, score, rank, present_in_corpus)
    rows: list[tuple[str, str, float, int, bool]] = []
    for case in cases:
        q = embed(f"{case.subject}\n{case.body}")
        scored = sorted(
            ((cosine(q, vec), key) for key, _snip, vec in chunks), reverse=True
        )
        rank_of = {key: i + 1 for i, (_s, key) in enumerate(scored)}
        score_of = {key: s for s, key in scored}
        for want in case.outcome.grounding_ids:
            if want not in keys:
                rows.append((case.id, want, 0.0, 0, False))
                continue
            rows.append((case.id, want, score_of[want], rank_of[want], True))

    absent = [(c, w) for c, w, _s, _r, present in rows if not present]
    if absent:
        print("EXPECTED CHUNKS NOT IN THE CORPUS AT ALL (a dataset or ingest bug,")
        print("not a threshold question — no floor can retrieve these):")
        for cid, want in absent:
            print(f"  {cid:<16} {want}")
        print()

    live = [r for r in rows if r[4]]

    print(f"required chunks that today's settings would return (floor {args.floor}, k {args.k}):")
    ok = [r for r in live if r[2] >= args.floor and r[3] <= args.k]
    bad = [r for r in live if not (r[2] >= args.floor and r[3] <= args.k)]
    print(f"  {len(ok)}/{len(live)} ({len(ok) / len(live):.0%})\n")

    if bad:
        print("unreachable today — why:")
        for cid, want, score, rank, _p in sorted(bad, key=lambda r: r[2]):
            why = []
            if score < args.floor:
                why.append(f"below floor ({score:.4f} < {args.floor})")
            if rank > args.k:
                why.append(f"rank {rank} > k={args.k}")
            print(f"  {cid:<16} {want:<24} {score:.4f}  rank {rank:<3} {'; '.join(why)}")
        print()

    print("floor sweep — share of required chunks returned, by floor and k")
    print("  floor    k=3     k=5     k=8     k=10")
    for f in FLOORS:
        cells = []
        for k in (3, 5, 8, 10):
            hit = sum(1 for _c, _w, s, r, _p in live if s >= f and r <= k)
            cells.append(f"{hit / len(live):.0%}".rjust(6))
        mark = "  <- in use" if abs(f - args.floor) < 1e-9 else ""
        print(f"  {f:.2f} {' '.join(cells)}{mark}")

    print(
        "\nk is the cheaper lever: raising it costs context, lowering the floor\n"
        "admits weaker evidence into a cited answer. Read the unreachable list\n"
        "above — a chunk at rank 1 that is below the floor argues for the floor,\n"
        "a chunk at rank 9 that clears it argues for k."
    )

    if not args.case:
        escalation_headroom(chunks, args.floor)


def escalation_headroom(chunks: list[tuple[str, str, list[float]]], floor: float) -> None:
    """How far below the floor do the cases that MUST escalate sit?

    Recall is only half the question. Lowering the floor to reach a required
    chunk also lowers it for the out-of-scope and adversarial cases, which have
    no grounding_ids and must retrieve nothing: a spurious chunk gives the model
    something to cite, and a cited answer satisfies the empty-citation guard
    that makes those cases escalate in the first place.

    So the safe floor is bounded below by recall and above by the best score any
    escalation case achieves. If those two bounds cross, no single floor works
    and the fix is the corpus or the queries, not the threshold.
    """
    escalation = [c for c in load_cases() if not c.outcome.grounding_ids]
    if not escalation:
        print("\nno escalation cases found — skipping the headroom check")
        return

    print(f"\n\nescalation headroom — {len(escalation)} cases that must retrieve nothing")
    print("  case             top score  chunk")
    tops = []
    for case in escalation:
        q = embed(f"{case.subject}\n{case.body}")
        best, key, snip = max(
            ((cosine(q, vec), key, snip) for key, snip, vec in chunks),
            key=lambda t: t[0],
        )
        tops.append((case.id, best, key))
        print(f"  {case.id:<16} {best:.4f}   {key} — {snip}")

    worst = max(b for _c, b, _k in tops)
    offenders = [(c, b, k) for c, b, k in tops if b >= floor]
    print(f"\n  highest escalation-case score: {worst:.4f}")
    if offenders:
        print(f"  ALREADY above the floor of {floor} — these can retrieve evidence today:")
        for cid, best, key in offenders:
            print(f"    {cid} {best:.4f} {key}")
    print(
        f"\n  a floor must stay above {worst:.4f} to keep every escalation case\n"
        f"  empty-handed. Compare that with the lowest required-chunk score in\n"
        f"  the unreachable list above: if the required score is higher, any\n"
        f"  floor between them satisfies both, and the gap is your margin."
    )


if __name__ == "__main__":
    main()
