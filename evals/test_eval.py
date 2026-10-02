"""Tests for the eval harness — deterministic metrics, judge separation, gate.

Run: cd eval && python -m pytest test_eval.py -q
No DB or model needed: RunData is constructed directly and the judge is stubbed.
"""
from __future__ import annotations

import pytest

from cases import Bucket, Suite, load_cases, load_suite, SMOKE_IDS
from trajectory_judge import JudgeConfig, reasoning_quality
from metrics import RunData, score_deterministic
from trajectory_judge import _extract_ids
from run import build_scorecard, CaseScore


def case_by_id(cid: str):
    return next(c for c in load_cases() if c.id == cid)


def good_run(**over) -> RunData:
    base = dict(
        terminal_state="completed",
        step_count=2,
        total_tokens=5000,
        steps=[["search_policies"], ["triage_ticket"]],
        submitted_citations=["chunk-pcp-01"],
        observed_ids={"chunk-pcp-01"},
        escalated=False,
        # matches base-01, the case the shared fixture is scored against
        submitted_category="plan_administration",
        submitted_priority="low",
    )
    base.update(over)
    return RunData(**base)


# ---------------- golden set integrity ----------------

def test_golden_set_has_40_cases_across_five_buckets():
    cases = load_cases()
    assert len(cases) == 40
    counts = {b: sum(1 for c in cases if c.bucket is b) for b in Bucket}
    assert counts[Bucket.BASE] == 15
    assert counts[Bucket.MULTIHOP] == 10
    assert counts[Bucket.ADVERSARIAL] == 5
    assert counts[Bucket.OUT_OF_SCOPE] == 5
    assert counts[Bucket.BUDGET] == 5


def test_smoke_suite_is_the_ten_declared_ids():
    smoke = load_suite(Suite.SMOKE)
    assert {c.id for c in smoke} == set(SMOKE_IDS)
    assert len(smoke) == 10


# ---------------- deterministic metrics ----------------

def test_clean_base_run_passes_every_deterministic_metric():
    results = score_deterministic(case_by_id("base-01"), good_run())
    assert all(r.passed for r in results), [r.detail for r in results if not r.passed]


def test_hallucinated_citation_fails_grounding():
    run = good_run(submitted_citations=["chunk-does-not-exist"], observed_ids={"chunk-pcp-01"})
    results = {r.metric: r for r in score_deterministic(case_by_id("base-01"), run)}
    assert not results["retrieval_grounding"].passed
    assert "chunk-does-not-exist" in results["retrieval_grounding"].detail


def test_missing_required_tool_fails_tool_choice():
    run = good_run(steps=[["triage_ticket"]], step_count=1)  # never searched
    results = {r.metric: r for r in score_deterministic(case_by_id("base-01"), run)}
    assert not results["tool_choice_correctness"].passed
    assert not results["min_retrieval"].passed


def test_multihop_requires_two_retrieval_calls():
    case = case_by_id("multihop-01")
    one = good_run(steps=[["search_policies"], ["triage_ticket"]],
                   submitted_citations=["chunk-qle-12"], observed_ids={"chunk-qle-12"})
    two = good_run(step_count=3,
                   steps=[["search_policies"], ["search_policies"], ["triage_ticket"]],
                   submitted_citations=["chunk-qle-12"], observed_ids={"chunk-qle-12"})
    assert not {r.metric: r for r in score_deterministic(case, one)}["min_retrieval"].passed
    assert {r.metric: r for r in score_deterministic(case, two)}["min_retrieval"].passed


def test_out_of_scope_requires_escalation():
    case = case_by_id("oos-01")
    triaged = good_run(steps=[["search_policies"], ["triage_ticket"]], escalated=False)
    escalated = good_run(steps=[["escalate_to_human"]], step_count=1, escalated=True,
                         submitted_citations=[], observed_ids=set())
    assert not {r.metric: r for r in score_deterministic(case, triaged)}["escalation_correctness"].passed
    assert {r.metric: r for r in score_deterministic(case, escalated)}["escalation_correctness"].passed


def test_forced_terminal_state_fails_loop_discipline():
    run = good_run(terminal_state="max_steps")
    results = {r.metric: r for r in score_deterministic(case_by_id("base-01"), run)}
    assert not results["loop_discipline"].passed


def test_redundant_consecutive_call_fails_efficiency():
    run = good_run(step_count=3,
                   steps=[["search_policies"], ["search_policies"], ["triage_ticket"]])
    # base-01 max_steps=4 so it's within bound, but the duplicate consecutive sig trips redundancy
    results = {r.metric: r for r in score_deterministic(case_by_id("base-01"), run)}
    assert not results["step_efficiency"].passed


def test_budget_ceiling_enforced():
    run = good_run(total_tokens=999_999)
    results = {r.metric: r for r in score_deterministic(case_by_id("base-01"), run)}
    assert not results["token_budget_adherence"].passed


# ---------------- judge separation ----------------

def test_judge_must_be_different_family_than_worker():
    same = JudgeConfig(worker_family="claude", judge_model="claude-haiku", judge_family="claude")
    with pytest.raises(ValueError, match="judge-model separation"):
        reasoning_quality(case_by_id("base-01"), "reasoning", {}, lambda p: "{}", same)


def test_reasoning_quality_parses_judge_json():
    cfg = JudgeConfig(worker_family="claude", judge_model="gpt-4o-mini", judge_family="gpt")
    stub = lambda prompt: '{"score": 0.9, "reason": "well grounded"}'
    r = reasoning_quality(case_by_id("base-01"), "reasoning", {"category": "x"}, stub, cfg)
    assert r.passed and r.score == 0.9


def test_reasoning_quality_handles_unparseable_output():
    cfg = JudgeConfig(worker_family="claude", judge_model="gpt-4o-mini", judge_family="gpt")
    r = reasoning_quality(case_by_id("base-01"), "reasoning", {}, lambda p: "not json", cfg)
    assert not r.passed and r.score == 0.0


# ---------------- scorecard / gate ----------------

def test_scorecard_aggregates_by_metric_and_bucket():
    scores = [
        CaseScore("base-01", "base", "r1",
                  [{"metric": "loop_discipline", "score": 1.0, "passed": True, "detail": ""}], True),
        CaseScore("oos-01", "out_of_scope", "r2",
                  [{"metric": "loop_discipline", "score": 0.0, "passed": False, "detail": ""}], False),
    ]
    card = build_scorecard(scores, "smoke")
    assert card["cases"] == 2
    assert card["case_pass_rate"] == 0.5
    assert card["by_metric"]["loop_discipline"]["rate"] == 0.5
    assert card["by_bucket"]["out_of_scope"]["rate"] == 0.0
    assert card["failures"] == [{"case_id": "oos-01", "failed": ["loop_discipline"]}]


# ---------------- outcome metrics ----------------

def _metric(results, name):
    return next(r for r in results if r.metric == name)


def test_wrong_category_fails_outcome_even_with_a_clean_trajectory():
    case = case_by_id("base-01")
    run = good_run(
        submitted_category="billing",
        submitted_citations=list(case.outcome.grounding_ids) or ["chunk-pcp-01"],
        observed_ids=set(case.outcome.grounding_ids) | {"chunk-pcp-01"},
    )
    results = score_deterministic(case, run)
    outcome = _metric(results, "outcome_correctness")
    assert not outcome.passed
    assert "billing" in outcome.detail
    # the trajectory itself was fine — this is the gap the metric closes
    assert _metric(results, "loop_discipline").passed
    assert _metric(results, "retrieval_grounding").passed


def test_outcome_comparison_ignores_case_and_padding():
    case = case_by_id("base-01")
    expected = case.outcome
    run = good_run(
        submitted_category=(expected.category or "plan_administration").upper(),
        submitted_priority=(expected.priority or "low").title() + " ",
        submitted_citations=list(expected.grounding_ids) or ["chunk-pcp-01"],
        observed_ids=set(expected.grounding_ids) | {"chunk-pcp-01"},
    )
    assert _metric(score_deterministic(case, run), "outcome_correctness").passed


def test_escalation_cases_skip_outcome_correctness():
    case = case_by_id("oos-01")
    run = good_run(
        steps=[["escalate_to_human"]],
        step_count=1,
        escalated=True,
        submitted_citations=[],
        observed_ids=set(),
        submitted_category=None,
        submitted_priority=None,
    )
    result = _metric(score_deterministic(case, run), "outcome_correctness")
    assert result.passed and "n/a" in result.detail


def test_multihop_citing_only_half_the_evidence_fails_recall():
    case = case_by_id("multihop-01")
    expected = case.outcome.grounding_ids
    assert len(expected) >= 2, "this test needs a case with multiple grounding ids"
    run = good_run(
        steps=[["search_policies"], ["search_policies"], ["triage_ticket"]],
        step_count=3,
        submitted_citations=[expected[0]],
        observed_ids=set(expected),
        submitted_category=case.outcome.category,
        submitted_priority=case.outcome.priority,
    )
    results = score_deterministic(case, run)
    recall = _metric(results, "grounding_recall")
    assert not recall.passed
    assert expected[1] in recall.detail
    # citing a subset is not hallucinating — the inverse metric still passes
    assert _metric(results, "retrieval_grounding").passed


def test_citing_every_expected_chunk_passes_recall():
    case = case_by_id("multihop-01")
    expected = list(case.outcome.grounding_ids)
    run = good_run(
        steps=[["search_policies"], ["search_policies"], ["triage_ticket"]],
        step_count=3,
        submitted_citations=expected,
        observed_ids=set(expected),
        submitted_category=case.outcome.category,
        submitted_priority=case.outcome.priority,
    )
    assert _metric(score_deterministic(case, run), "grounding_recall").passed


# ---------------- id extraction from real tool summaries ----------------

def test_ids_are_recovered_from_the_summaries_the_tools_actually_write():
    policy = (
        'search_policies("spouse lost coverage") -> 2 chunks '
        "[chunk-qle-12, chunk-cobra-04], top score 0.82"
    )
    tickets = "find_similar_tickets -> 1 matches [R-2201], top score 0.77"
    assert _extract_ids(policy) == {"chunk-qle-12", "chunk-cobra-04"}
    assert _extract_ids(tickets) == {"R-2201"}


def test_serial_id_fallback_is_recovered_too():
    assert _extract_ids("search_policies(\"q\") -> 1 chunks [chunk-312], top score 0.6") == {
        "chunk-312"
    }
