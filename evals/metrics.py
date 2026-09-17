"""Deterministic trajectory metrics (spec §8).

These read the persisted agent_runs / agent_steps / token_ledger rows — NO judge
calls — so they run on every PR. Each returns a MetricResult with a 0/1 score and
a human-readable detail. The judge-based reasoning metric lives in judge.py and
runs nightly only.
"""
from __future__ import annotations

from dataclasses import dataclass

from cases import GoldenCase

RETRIEVAL_TOOLS = {"search_policies", "find_similar_tickets", "traverse_policy_graph"}


@dataclass(frozen=True)
class RunData:
    """Projection of one run assembled from the persisted tables."""
    terminal_state: str
    step_count: int
    total_tokens: int
    # ordered per-step tool-call name lists, from agent_steps.tool_calls
    steps: list[list[str]]
    # citations submitted to the terminal triage tool (from the terminal step args)
    submitted_citations: list[str]
    # every chunk/ticket id that actually appeared in a tool result this run
    observed_ids: set[str]
    escalated: bool

    @property
    def all_tools(self) -> list[str]:
        return [t for step in self.steps for t in step]

    @property
    def retrieval_calls(self) -> int:
        return sum(1 for t in self.all_tools if t in RETRIEVAL_TOOLS)


@dataclass(frozen=True)
class MetricResult:
    metric: str
    score: float  # 0.0 or 1.0 for deterministic metrics
    passed: bool
    detail: str


def tool_choice_correctness(case: GoldenCase, run: RunData) -> MetricResult:
    tools = set(run.all_tools)
    missing = [t for t in case.trajectory.required_tools if t not in tools]
    forbidden = [t for t in case.trajectory.forbidden_tools if t in tools]
    ok = not missing and not forbidden
    detail = "ok" if ok else f"missing={missing} forbidden_used={forbidden}"
    return MetricResult("tool_choice_correctness", float(ok), ok, detail)


def step_efficiency(case: GoldenCase, run: RunData) -> MetricResult:
    within = run.step_count <= case.trajectory.max_steps
    # penalize exact-duplicate consecutive tool signatures as redundant
    sigs = ["+".join(sorted(s)) for s in run.steps]
    redundant = any(sigs[i] == sigs[i - 1] and sigs[i] for i in range(1, len(sigs)))
    ok = within and not redundant
    detail = f"steps={run.step_count}/{case.trajectory.max_steps} redundant={redundant}"
    return MetricResult("step_efficiency", float(ok), ok, detail)


def retrieval_grounding(case: GoldenCase, run: RunData) -> MetricResult:
    """Every submitted citation must be an id the run actually retrieved."""
    hallucinated = [c for c in run.submitted_citations if c not in run.observed_ids]
    ok = not hallucinated
    detail = "ok" if ok else f"hallucinated_citations={hallucinated}"
    return MetricResult("retrieval_grounding", float(ok), ok, detail)


def loop_discipline(case: GoldenCase, run: RunData) -> MetricResult:
    ok = run.terminal_state in case.trajectory.allowed_terminal_states
    detail = f"terminal={run.terminal_state} allowed={case.trajectory.allowed_terminal_states}"
    return MetricResult("loop_discipline", float(ok), ok, detail)


def min_retrieval(case: GoldenCase, run: RunData) -> MetricResult:
    need = case.trajectory.min_retrieval_calls
    ok = run.retrieval_calls >= need
    detail = f"retrieval_calls={run.retrieval_calls} need>={need}"
    return MetricResult("min_retrieval", float(ok), ok, detail)


def token_budget_adherence(case: GoldenCase, run: RunData) -> MetricResult:
    ok = run.total_tokens <= case.trajectory.token_ceiling
    detail = f"tokens={run.total_tokens}/{case.trajectory.token_ceiling}"
    return MetricResult("token_budget_adherence", float(ok), ok, detail)


def escalation_correctness(case: GoldenCase, run: RunData) -> MetricResult:
    """Out-of-scope/adversarial cases must escalate; normal cases must not."""
    expected = case.outcome.must_escalate
    ok = run.escalated == expected
    detail = f"escalated={run.escalated} expected={expected}"
    return MetricResult("escalation_correctness", float(ok), ok, detail)


DETERMINISTIC_METRICS = [
    tool_choice_correctness,
    step_efficiency,
    retrieval_grounding,
    loop_discipline,
    min_retrieval,
    token_budget_adherence,
    escalation_correctness,
]


def score_deterministic(case: GoldenCase, run: RunData) -> list[MetricResult]:
    return [m(case, run) for m in DETERMINISTIC_METRICS]
