"""What the judge is shown about a run.

These exist because the bug they cover was unreachable by any test: the logic
lived in wiring.py, which is gitignored. The first full Claude nightly failed
oos-01 with "the agent ... did not escalate" while escalation_correctness
scored 40/40 — the agent escalated and the judge was never told, because only
triage_ticket's arguments were collected.

Run: cd evals && python -m pytest test_trajectory_io.py -q
"""

from __future__ import annotations

import pytest

from trajectory_io import describe_final, load_scratch_and_final


class _Cur:
    def __init__(self, rows):
        self.rows = rows
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, *a, **k): pass
    def fetchall(self): return self.rows


class _Conn:
    def __init__(self, rows): self.rows = rows
    def cursor(self): return _Cur(self.rows)


TRIAGE = {"name": "triage_ticket", "args": {"category": "enrollment", "priority": "high",
                                            "citations": ["chunk-qle-12"], "summary": "QLE."}}
ESCALATE = {"name": "escalate_to_human", "args": {"ticketId": "oos-01",
                                                  "reason": "Payroll, not benefits."}}
SEARCH = {"name": "search_policies", "args": {"query": "x", "k": 5}}


def test_an_escalated_run_is_reported_as_escalated():
    # The regression this file exists for.
    _scratch, final = load_scratch_and_final(_Conn([("thinking", [SEARCH]), ("", [ESCALATE])]), "r1")
    assert final["tool"] == "escalate_to_human"
    assert final["reason"] == "Payroll, not benefits."


def test_an_answered_run_keeps_its_triage_arguments():
    _scratch, final = load_scratch_and_final(_Conn([("", [SEARCH]), ("", [TRIAGE])]), "r1")
    assert final["tool"] == "triage_ticket"
    assert final["category"] == "enrollment"


def test_the_last_terminal_call_wins():
    # A run nudged into a final answer can carry an earlier rejected attempt.
    rejected = {"name": "triage_ticket", "args": {"category": "wrong"}}
    _scratch, final = load_scratch_and_final(_Conn([("", [rejected]), ("", [TRIAGE])]), "r1")
    assert final["category"] == "enrollment"


def test_scratchpads_are_joined_and_blanks_dropped():
    scratch, _final = load_scratch_and_final(
        _Conn([("first", [SEARCH]), ("", [SEARCH]), ("second", [TRIAGE])]), "r1"
    )
    assert scratch == "first\nsecond"


def test_a_run_with_no_terminal_call_yields_an_empty_final():
    _scratch, final = load_scratch_and_final(_Conn([("thinking", [SEARCH])]), "r1")
    assert final == {}


def test_describe_final_states_escalation_in_words():
    # A judge handed {"tool": "escalate_to_human"} still asserted the agent had
    # not escalated, so the prompt says it in prose too.
    text = describe_final({"tool": "escalate_to_human", "reason": "Out of scope."})
    assert "ESCALATED" in text and "Out of scope." in text


def test_describe_final_states_an_answer_with_its_citations():
    text = describe_final({"tool": "triage_ticket", "category": "enrollment",
                           "priority": "high", "citations": ["chunk-qle-12"],
                           "summary": "QLE applies."})
    assert "ANSWERED" in text
    assert "chunk-qle-12" in text and "enrollment" in text


def test_describe_final_handles_a_run_that_never_decided():
    assert "no terminal decision" in describe_final({})


def test_escalation_cases_get_the_escalation_rubric():
    # The shared prompt scores "grounded in evidence rather than assertion",
    # which is backwards for a ticket the corpus does not cover.
    from cases import load_cases
    from trajectory_judge import JudgeConfig, reasoning_quality

    oos = next(c for c in load_cases() if not c.outcome.grounding_ids)
    seen = {}

    def judge(prompt):
        seen["prompt"] = prompt
        return '{"score": 1.0, "reason": "sound hand-off"}'

    res = reasoning_quality(
        oos, "This is a payroll question.", {"tool": "escalate_to_human", "reason": "Payroll."},
        judge, JudgeConfig("claude", "llama3.1", "llama"),
    )
    assert res.passed
    assert "SUPPOSED to hand off" in seen["prompt"]
    assert "do not penalise it for lacking" in seen["prompt"]
    assert "ESCALATED" in seen["prompt"]


def test_answerable_cases_keep_the_evidence_rubric():
    from cases import load_cases
    from trajectory_judge import JudgeConfig, reasoning_quality

    case = next(c for c in load_cases() if c.outcome.grounding_ids)
    seen = {}

    def judge(prompt):
        seen["prompt"] = prompt
        return '{"score": 0.9, "reason": "grounded"}'

    reasoning_quality(case, "Found the QLE chunk.", {"tool": "triage_ticket", "category": "x"},
                      judge, JudgeConfig("claude", "llama3.1", "llama"))
    assert "SUPPOSED to hand off" not in seen["prompt"]
    assert "grounded in evidence rather than assertion" in seen["prompt"]
