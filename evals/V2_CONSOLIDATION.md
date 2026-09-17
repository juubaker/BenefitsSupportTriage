# Eval v2 — consolidation with your existing evals/

Your repo already has: `evals/api_client.py`, `evals/judge.py`,
`evals/golden_dataset.json`, `evals/test_rag_metrics.py`. The v2 work extends
answer-quality scoring with TRAJECTORY scoring. These files drop into the SAME
`evals/` folder. Collisions were renamed so nothing overwrites your work:

| v2 file                | purpose                                              | collision handling |
|------------------------|------------------------------------------------------|--------------------|
| cases.py               | GoldenCase schema + YAML loader (40 cases)           | new, no collision  |
| metrics.py             | 7 deterministic trajectory metrics (read the tables) | new, no collision  |
| trajectory_judge.py    | RunData loader + judge-model reasoning metric        | RENAMED from judge.py to avoid clobbering your existing evals/judge.py |
| run.py                 | suite runner, scorecard, CI gate                     | new; check you have no other run.py |
| test_eval.py           | 14 harness self-tests                                | new                |
| wiring.example.py      | deployment glue -> copy to wiring.py                 | new                |
| requirements.txt       | pyyaml, pytest, psycopg, requests                    | MERGE with any existing requirements |
| golden/*.yaml          | 40 golden cases across 5 buckets (+2 graph)          | new subfolder      |

## Two decisions for you

1. **judge.py vs trajectory_judge.py.** Your existing `evals/judge.py` is the v1
   answer-quality judge. The v2 reasoning-quality judge is now
   `trajectory_judge.py`. If they should be one module, merge them by hand — I
   kept them separate rather than guess at overwriting your working code.

2. **golden_dataset.json vs golden/*.yaml.** Your v1 uses a JSON dataset; v2 uses
   per-bucket YAML with trajectory expectations. They can coexist (different
   scorers read different sources), or you can port the JSON cases into the YAML
   buckets. cases.py only reads golden/*.yaml.

## Run

```
cd evals
pip install -r requirements.txt
python -m pytest test_eval.py -q          # 14 pass
cp wiring.example.py wiring.py            # fill in DB conn + judge client
python -m run --suite smoke --min-pass-rate 0.9
```
