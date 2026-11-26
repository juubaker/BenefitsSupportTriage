"""Scorecard shape: what build_scorecard reports beyond pass/fail counts.

Split out of test_eval.py so the two files stop colliding; the provenance
and detail fields are the parts a reader of a committed scorecard relies on.

Run: cd evals && python -m pytest test_scorecard.py -q
"""

from __future__ import annotations

from run import build_scorecard, CaseScore


def test_failures_carry_the_detail_that_explains_them():
    # "outcome_correctness failed" alone sends you to the DB; the metric
    # already knows what the run decided.
    detail = "category='enrollment' expected='eligibility' priority='medium' expected='medium'"
    scores = [
        CaseScore("multihop-02", "multihop", "r1",
                  [{"metric": "outcome_correctness", "score": 0.0, "passed": False, "detail": detail},
                   {"metric": "loop_discipline", "score": 1.0, "passed": True, "detail": "ok"}],
                  False),
    ]
    card = build_scorecard(scores, "smoke")
    assert card["failures"] == [
        {"case_id": "multihop-02",
         "failed": [{"metric": "outcome_correctness", "score": 0.0, "detail": detail}]}
    ]
