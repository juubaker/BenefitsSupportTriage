"""
RAG evaluation suite for the Benefits Support Triage Agent.

Run with:  deepeval test run test_rag_metrics.py
(or plain pytest, but `deepeval test run` gives per-metric score output
and can sync results to Confident AI if you're logged in.)

Four metrics, and what each one tells you when it fails:

  Faithfulness          -> generation problem. The answer contains claims
                           not supported by the retrieved chunks
                           (hallucination against the corpus).
  Contextual Precision  -> ranking problem. Relevant chunks were retrieved
                           but irrelevant ones were ranked above them.
                           Look at your pgvector similarity ordering /
                           any re-ranking step.
  Contextual Recall     -> retrieval problem. Chunks needed to produce the
                           expected answer weren't retrieved at all. Look
                           at chunking strategy, embedding quality
                           (nomic-embed-text), or top-k.
  Contextual Relevancy  -> noise problem. Too much of what was retrieved
                           is irrelevant to the question. Usually top-k is
                           too high or chunks are too coarse.

This split — retrieval quality vs. generation faithfulness — is the whole
point of running four metrics instead of one end-to-end "correctness" score.
"""

import json
import pathlib

import pytest
from deepeval import assert_test
from deepeval.metrics import (
    ContextualPrecisionMetric,
    ContextualRecallMetric,
    ContextualRelevancyMetric,
    FaithfulnessMetric,
)
from deepeval.test_case import LLMTestCase

from api_client import ask_agent
from judge import get_judge

# ---------------------------------------------------------------------------
# Load golden dataset
# ---------------------------------------------------------------------------
DATASET_PATH = pathlib.Path(__file__).parent / "golden_dataset.json"
GOLDEN_CASES = json.loads(DATASET_PATH.read_text())["cases"]

# ---------------------------------------------------------------------------
# Thresholds. Start permissive, ratchet up as the system improves —
# a failing suite nobody trusts is worse than a slightly soft one.
# ---------------------------------------------------------------------------
THRESHOLDS = {
    "faithfulness": 0.8,
    "contextual_precision": 0.7,
    "contextual_recall": 0.7,
    "contextual_relevancy": 0.6,
}

# One judge instance shared across metrics (avoids re-auth per test).
_judge = get_judge()


def build_metrics():
    """Fresh metric instances per test case (deepeval metrics hold state)."""
    return [
        FaithfulnessMetric(
            threshold=THRESHOLDS["faithfulness"], model=_judge, include_reason=True
        ),
        ContextualPrecisionMetric(
            threshold=THRESHOLDS["contextual_precision"],
            model=_judge,
            include_reason=True,
        ),
        ContextualRecallMetric(
            threshold=THRESHOLDS["contextual_recall"],
            model=_judge,
            include_reason=True,
        ),
        ContextualRelevancyMetric(
            threshold=THRESHOLDS["contextual_relevancy"],
            model=_judge,
            include_reason=True,
        ),
    ]


# ---------------------------------------------------------------------------
# The tests. One parametrized test per golden case; each case is scored
# against all four metrics. Case IDs show up in pytest/deepeval output so
# failures are traceable to a specific question.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "case", GOLDEN_CASES, ids=[c["id"] for c in GOLDEN_CASES]
)
def test_rag_quality(case):
    result = ask_agent(case["input"])

    if not result["retrieval_context"]:
        pytest.fail(
            f"[{case['id']}] API returned no retrieval context. The RAG "
            "metrics need the retrieved chunk texts — see ADJUST #2 in "
            "api_client.py."
        )

    test_case = LLMTestCase(
        input=case["input"],
        actual_output=result["answer"],
        expected_output=case["expected_output"],
        retrieval_context=result["retrieval_context"],
    )

    assert_test(test_case, build_metrics())
