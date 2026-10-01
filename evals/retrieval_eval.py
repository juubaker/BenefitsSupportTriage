"""Retrieval-only eval: does policy search surface the labeled grounding chunks?

Local and free — Ollama embeddings + the policy_chunks table, no judge calls.
Scores each golden case's body against the corpus and reports, per embedding
variant:

  * ranking quality on answerable cases (a labeled grounding id exists in the
    corpus): hit@1, hit@3, recall@k, MRR — independent of any threshold;
  * a similarity-threshold sweep: recall of labeled chunks that clear the
    threshold vs. how often cases with nothing to ground on correctly get an
    empty result (out-of-scope, adversarial, and topics the corpus lacks).

Variants:
  raw       — what production serves today: stored embeddings, bare query.
  prefixed  — nomic-embed-text task prefixes ("search_query: " /
              "search_document: "); docs re-embedded in memory, DB untouched.

Usage:
  python retrieval_eval.py                 # both variants, top_k=5
  python retrieval_eval.py --variant raw --top-k 3 --json out.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import urllib.request
from dataclasses import dataclass

import psycopg

from cases import GoldenCase, load_cases

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://triage:triage@localhost:5433/triage")
THRESHOLDS = [round(0.50 + 0.025 * i, 3) for i in range(13)]  # 0.500 .. 0.800
SERVER_THRESHOLD = 0.7  # search_policies default min_similarity


@dataclass
class Chunk:
    key: str | None
    section: str | None
    text: str
    stored: list[float]


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


def load_chunks() -> list[Chunk]:
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            "select chunk_key, section, chunk_text, embedding::text from policy_chunks order by id"
        ).fetchall()
    return [Chunk(k, s, t, json.loads(e)) for k, s, t, e in rows]


def rank(case: GoldenCase, chunks: list[Chunk], variant: str, doc_vecs: list[list[float]]):
    q = embed(("search_query: " if variant == "prefixed" else "") + case.body)
    scored = [(cosine(q, v), c.key or c.section) for c, v in zip(chunks, doc_vecs)]
    return sorted(scored, reverse=True)


def evaluate(cases: list[GoldenCase], chunks: list[Chunk], variant: str, top_k: int) -> dict:
    corpus_keys = {c.key for c in chunks if c.key}
    if variant == "prefixed":
        doc_vecs = [embed("search_document: " + c.text) for c in chunks]
    else:
        doc_vecs = [c.stored for c in chunks]

    per_case = []
    for case in cases:
        ranked = rank(case, chunks, variant, doc_vecs)
        gold = set(case.outcome.grounding_ids)
        present = gold & corpus_keys
        keys = [k for _, k in ranked]
        first_hit = next((i for i, k in enumerate(keys) if k in present), None)
        per_case.append({
            "id": case.id,
            "answerable": bool(present),
            "gold_present": sorted(present),
            "gold_missing_from_corpus": sorted(gold - corpus_keys),
            "top": [{"key": k, "sim": round(s, 4)} for s, k in ranked[:top_k]],
            "first_gold_rank": None if first_hit is None else first_hit + 1,
            "gold_sims": {k: round(s, 4) for s, k in ranked if k in present},
        })

    ans = [c for c in per_case if c["answerable"]]
    abst = [c for c in per_case if not c["answerable"]]

    def hit_at(n):
        return sum(1 for c in ans if c["first_gold_rank"] and c["first_gold_rank"] <= n) / len(ans)

    def recall_at_k(c):
        in_top = {t["key"] for t in c["top"]}
        return len(set(c["gold_present"]) & in_top) / len(c["gold_present"])

    sweep = []
    for t in THRESHOLDS:
        rec = sum(
            len([k for k in c["gold_present"]
                 if any(x["key"] == k and x["sim"] >= t for x in c["top"])]) / len(c["gold_present"])
            for c in ans
        ) / len(ans)
        abstain = sum(1 for c in abst if c["top"][0]["sim"] < t) / len(abst) if abst else 0.0
        sweep.append({"threshold": t, "recall": round(rec, 3), "abstain_acc": round(abstain, 3),
                      "balanced": round((rec + abstain) / 2, 3)})

    return {
        "variant": variant,
        "top_k": top_k,
        "n_answerable": len(ans),
        "n_abstain": len(abst),
        "hit@1": round(hit_at(1), 3),
        "hit@3": round(hit_at(3), 3),
        f"recall@{top_k}": round(sum(recall_at_k(c) for c in ans) / len(ans), 3),
        "mrr": round(sum(1 / c["first_gold_rank"] for c in ans if c["first_gold_rank"]) / len(ans), 3),
        "sweep": sweep,
        "best_threshold": max(sweep, key=lambda s: (s["balanced"], s["recall"])),
        "cases": per_case,
    }


def report(r: dict) -> None:
    print(f"\n=== {r['variant']}  (answerable={r['n_answerable']}, expect-empty={r['n_abstain']}) ===")
    k = r["top_k"]
    print(f"hit@1={r['hit@1']}  hit@3={r['hit@3']}  recall@{k}={r['recall@' + str(k)]}  mrr={r['mrr']}")
    print("threshold  recall  abstain  balanced")
    for s in r["sweep"]:
        mark = " <- best" if s is r["best_threshold"] else (" <- server" if s["threshold"] == SERVER_THRESHOLD else "")
        print(f"  {s['threshold']:.3f}   {s['recall']:.3f}   {s['abstain_acc']:.3f}    {s['balanced']:.3f}{mark}")
    print("answerable cases (gold -> rank @ sim):")
    for c in r["cases"]:
        if c["answerable"]:
            top_keys = [t["key"] for t in c["top"]]
            golds = ", ".join(
                f"{g} #{top_keys.index(g) + 1 if g in top_keys else '>k'} @{c['gold_sims'][g]}"
                for g in c["gold_present"]
            )
            flag = "" if c["first_gold_rank"] == 1 else "  MISS@1"
            print(f"  {c['id']:<16} {golds}  (top1={c['top'][0]['key']}){flag}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variant", choices=["raw", "prefixed", "both"], default="both")
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--json", help="write full per-case results here")
    args = ap.parse_args()

    cases = load_cases()
    chunks = load_chunks()
    if not any(c.key for c in chunks):
        raise SystemExit("policy_chunks has no chunk_key values — re-run rag ingest first.")
    missing = sorted({g for c in cases for g in c.outcome.grounding_ids} - {c.key for c in chunks})
    print(f"{len(cases)} cases, {len(chunks)} chunks. Labeled ids not in corpus ({len(missing)}): {', '.join(missing)}")

    variants = ["raw", "prefixed"] if args.variant == "both" else [args.variant]
    results = [evaluate(cases, chunks, v, args.top_k) for v in variants]
    for r in results:
        report(r)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()
