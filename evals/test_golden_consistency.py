"""The golden dataset must agree with the rubrics the agent is given.

A golden label that contradicts the prompt's own guidance is not a test of the
model, it is a test of nothing: the gate goes red for a decision the agent was
instructed to make. multihop-02 was labelled eligibility/medium while
CATEGORY_BOUNDARIES defines enrollment as an action on coverage "(add, drop,
switch)" and PRIORITY_GUIDANCE puts a running 31-day QLE window at high — so
the first correct Claude run failed the gate.

These checks are deliberately narrow. They assert the invariants the rubrics
state outright, not a view of what each case "should" be: a judgement call
belongs in the YAML with a comment, not in an assertion.

Run: cd evals && python -m pytest test_golden_consistency.py -q
"""

from __future__ import annotations

import pathlib
import re

import pytest

from cases import load_cases

# The taxonomy lives in TypeScript, which is the only copy the model is ever
# shown. Parsing it keeps the Python dataset from drifting away from it — that
# drift is what made four cases fail with "benefits-enrollment" against a
# taxonomy that says "enrollment".
TOOLS_TS = pathlib.Path(__file__).resolve().parents[1] / "agent" / "src" / "tools.ts"


def _ts_string_array(name: str) -> list[str]:
    src = TOOLS_TS.read_text()
    m = re.search(rf"export const {name} = \[(.*?)\] as const;", src, re.S)
    if not m:
        pytest.skip(f"{name} not found in {TOOLS_TS} — taxonomy moved?")
    return re.findall(r'"([^"]+)"', m.group(1))


@pytest.fixture(scope="module")
def categories() -> list[str]:
    return _ts_string_array("TRIAGE_CATEGORIES")


@pytest.fixture(scope="module")
def priorities() -> list[str]:
    return _ts_string_array("TRIAGE_PRIORITIES")


def test_the_taxonomy_was_actually_found(categories, priorities):
    # Guards the regex itself: an empty list would make every check below pass.
    assert "enrollment" in categories and "eligibility" in categories
    assert priorities == ["low", "medium", "high", "urgent"]


def test_every_golden_category_exists_in_the_agent_taxonomy(categories):
    bad = {
        c.id: c.outcome.category
        for c in load_cases()
        if c.outcome.category is not None and c.outcome.category not in categories
    }
    assert not bad, f"categories not in TRIAGE_CATEGORIES: {bad}"


def test_every_golden_priority_exists_in_the_agent_taxonomy(priorities):
    bad = {
        c.id: c.outcome.priority
        for c in load_cases()
        if c.outcome.priority is not None and c.outcome.priority not in priorities
    }
    assert not bad, f"priorities not in TRIAGE_PRIORITIES: {bad}"


def test_a_case_citing_the_qle_chunk_is_high_priority():
    """PRIORITY_GUIDANCE: high is "a deadline is running ... a qualifying life
    event and its 31-day window"; medium is explicitly "no deadline running".
    A case whose required evidence is the QLE chunk has a window running by
    construction, so medium contradicts the instruction the model follows."""
    offenders = {
        c.id: c.outcome.priority
        for c in load_cases()
        if any("qle" in gid for gid in c.outcome.grounding_ids)
        and c.outcome.priority is not None
        and c.outcome.priority != "high"
    }
    assert not offenders, (
        "cases cite the QLE chunk but are not high priority: "
        f"{offenders}. Either the priority is wrong or the case does not really "
        "turn on the 31-day window."
    )


def test_escalation_cases_declare_no_expected_outcome():
    """outcome_correctness passes vacuously when category and priority are both
    absent, which is how escalation cases are written — escalation_correctness
    covers them. A half-filled outcome on an escalation case would grade the
    agent on a decision it is supposed to refuse to make."""
    offenders = {
        c.id: (c.outcome.category, c.outcome.priority)
        for c in load_cases()
        if c.bucket.value in ("out_of_scope", "adversarial")
        and (c.outcome.category is not None or c.outcome.priority is not None)
    }
    assert not offenders, f"escalation cases with an expected outcome: {offenders}"


def _priority_guidance() -> str:
    src = TOOLS_TS.read_text()
    m = re.search(r"const PRIORITY_GUIDANCE = \[(.*?)\]\.join", src, re.S)
    if not m:
        pytest.skip("PRIORITY_GUIDANCE not found — moved?")
    return " ".join(re.findall(r'"([^"]*)"', m.group(1)))


def test_the_priority_examples_do_not_contradict_the_definitions():
    """A factual lookup cannot be a medium example.

    medium used to list "out-of-network costs" and "a disability waiting
    period". Both are plain questions about how the plan works, which is what
    low describes — and base-13 and base-08 ask them verbatim. The dataset was
    labelled from the examples and the agent answered from the definitions, so
    those two cases failed every nightly run for a contradiction in the prompt.
    """
    guidance = _priority_guidance()
    retired = ["out-of-network costs", "a disability waiting period"]
    back = [p for p in retired if p in guidance]
    assert not back, (
        f"these examples describe factual lookups but sit under medium: {back}. "
        "If medium really should cover them, change low's definition too and "
        "relabel base-08/base-13 — do not leave the two disagreeing."
    )


def test_the_low_medium_discriminator_is_stated_not_implied():
    # The split was decidable only by reading both definitions closely and
    # guessing which example list to trust. It should be said outright.
    guidance = _priority_guidance().lower()
    assert "how the plan works in general" in guidance
    assert "own circumstances are in play" in guidance


def test_high_names_the_new_hire_window():
    # multihop-04 is a new hire inside a 31-day window and was labelled medium.
    # The window belongs in the high examples so the case is decidable.
    assert "new hire" in _priority_guidance().lower()


def test_the_rubric_warns_that_form_is_not_the_test():
    """budget-03 is the case this exists for.

    Its surface question is "which copay tiers do these fall into", which the
    low examples describe; its context is "before open enrollment so I can pick
    the right plan" and "I am on a generic maintenance drug ... a specialty
    injectable", which makes it medium. The agent matched the form and answered
    low. The same words can sit in either band, so the rubric has to say that
    outright rather than leave it to the examples — the mistake the retired
    medium examples made in the other direction.
    """
    guidance = _priority_guidance().lower()
    assert "not by the form of the question" in guidance
    assert "the same words can be either" in guidance
