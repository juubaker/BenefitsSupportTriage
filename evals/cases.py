"""Golden case schema + loader (spec §8).

A golden case declares the ticket, the labeled expected outcome, and the
trajectory expectations the deterministic metrics score against. Cases live in
golden/*.yaml so non-engineers can review and add them; this module is the
single typed entry point.
"""
from __future__ import annotations

import glob
import os
from dataclasses import dataclass, field
from enum import Enum

import yaml


class Suite(str, Enum):
    SMOKE = "smoke"      # 10-case PR subset, Ollama, deterministic only
    NIGHTLY = "nightly"  # full 40, adds judge metrics


class Bucket(str, Enum):
    BASE = "base"                # 15 originals
    MULTIHOP = "multihop"        # >=2 retrieval calls required
    ADVERSARIAL = "adversarial"  # ambiguous; correct move is to clarify/escalate
    OUT_OF_SCOPE = "out_of_scope"  # must escalate_to_human
    BUDGET = "budget"            # long body; exercises compaction


@dataclass(frozen=True)
class ExpectedTrajectory:
    # Tools that MUST appear across the run (subset semantics).
    required_tools: list[str] = field(default_factory=list)
    # Tools that must NOT appear (e.g. a search on a pure out-of-scope case).
    forbidden_tools: list[str] = field(default_factory=list)
    # Upper bound on steps for the efficiency metric.
    max_steps: int = 8
    # Minimum distinct retrieval calls (multihop cases set >=2).
    min_retrieval_calls: int = 0
    # Acceptable terminal states (usually ["completed"]).
    allowed_terminal_states: list[str] = field(default_factory=lambda: ["completed"])
    # Per-case token ceiling for the budget-adherence metric.
    token_ceiling: int = 30_000


@dataclass(frozen=True)
class ExpectedOutcome:
    category: str | None = None
    priority: str | None = None
    must_escalate: bool = False
    # Chunk ids that a grounded answer should cite at least one of.
    grounding_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class GoldenCase:
    id: str
    bucket: Bucket
    subject: str
    body: str
    outcome: ExpectedOutcome
    trajectory: ExpectedTrajectory
    # Free-text rubric the judge model scores reasoning quality against.
    reasoning_rubric: str = ""

    @property
    def in_smoke(self) -> bool:
        # A stable 10-case subset: first two of each bucket by id order.
        return self.id in SMOKE_IDS


def _case_from_dict(d: dict) -> GoldenCase:
    return GoldenCase(
        id=d["id"],
        bucket=Bucket(d["bucket"]),
        subject=d["subject"],
        body=d["body"],
        outcome=ExpectedOutcome(**(d.get("outcome") or {})),
        trajectory=ExpectedTrajectory(**(d.get("trajectory") or {})),
        reasoning_rubric=d.get("reasoning_rubric", ""),
    )


def load_cases(golden_dir: str | None = None) -> list[GoldenCase]:
    golden_dir = golden_dir or os.path.join(os.path.dirname(__file__), "golden")
    # graph.yaml cases require the optional Phase 4 layer; include only when enabled.
    graph_enabled = os.environ.get("GRAPH_ENABLED") == "true"
    cases: list[GoldenCase] = []
    for path in sorted(glob.glob(os.path.join(golden_dir, "*.yaml"))):
        if os.path.basename(path) == "graph.yaml" and not graph_enabled:
            continue
        with open(path) as f:
            doc = yaml.safe_load(f)
        for raw in doc["cases"]:
            cases.append(_case_from_dict(raw))
    _validate(cases)
    return cases


def load_suite(suite: Suite, golden_dir: str | None = None) -> list[GoldenCase]:
    cases = load_cases(golden_dir)
    if suite is Suite.SMOKE:
        return [c for c in cases if c.in_smoke]
    return cases


def _validate(cases: list[GoldenCase]) -> None:
    ids = [c.id for c in cases]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(f"duplicate golden case ids: {sorted(dupes)}")
    missing = [i for i in SMOKE_IDS if i not in ids]
    if missing:
        raise ValueError(f"smoke ids not present in golden set: {missing}")


# The 10-case smoke subset — two per bucket, chosen for speed + coverage.
SMOKE_IDS: frozenset[str] = frozenset(
    {
        "base-01", "base-02",
        "multihop-01", "multihop-02",
        "adversarial-01", "adversarial-02",
        "oos-01", "oos-02",
        "budget-01", "budget-02",
    }
)
