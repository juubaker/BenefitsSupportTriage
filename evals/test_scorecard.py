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


# ---------------- progress reporting ----------------

class _FakeConnP:
    """Minimal conn for execute_suite: swallows persist writes, answers the
    provider-provenance query."""
    def __init__(self):
        self.committed = 0

    def cursor(self):
        conn = self

        class _C:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def execute(self, sql, *a, **k): self._sql = sql
            def fetchone(self): return ("anthropic", "claude-sonnet-4-6", ["anthropic"])
        return _C()

    def commit(self):
        self.committed += 1


def _deps_for_suite():
    from run import RunnerDeps
    return RunnerDeps(
        conn=_FakeConnP(),
        trigger_run=lambda payload, traceparent: f"run-{payload['ticketId']}",
        with_judge=False,
    )


def test_progress_lines_go_to_stderr_not_stdout(monkeypatch, capsys):
    # stdout stays a clean JSON document so the scorecard can be piped.
    import run as run_mod
    from cases import Suite
    from metrics import MetricResult

    monkeypatch.setattr(
        run_mod, "run_case",
        lambda case, deps: (f"run-{case.id}", [MetricResult("loop_discipline", 1.0, True, "ok")]),
    )
    card = run_mod.execute_suite(Suite.SMOKE, _deps_for_suite())
    out, err = capsys.readouterr()

    assert out == ""
    assert "[1/" in err and "ok" in err and "done:" in err
    assert card["cases"] == card["cases_passed"]


def test_progress_names_the_failing_metrics_as_they_happen(monkeypatch, capsys):
    # On a 40-minute suite you want to know it is going wrong at case 3.
    import run as run_mod
    from cases import Suite
    from metrics import MetricResult

    monkeypatch.setattr(
        run_mod, "run_case",
        lambda case, deps: (
            f"run-{case.id}",
            [MetricResult("outcome_correctness", 0.0, False, "category='x' expected='y'")],
        ),
    )
    run_mod.execute_suite(Suite.SMOKE, _deps_for_suite())
    _out, err = capsys.readouterr()

    assert "FAIL outcome_correctness" in err


def test_progress_can_be_switched_off(monkeypatch, capsys):
    import run as run_mod
    from cases import Suite
    from metrics import MetricResult

    monkeypatch.setattr(
        run_mod, "run_case",
        lambda case, deps: (f"run-{case.id}", [MetricResult("loop_discipline", 1.0, True, "ok")]),
    )
    run_mod.execute_suite(Suite.SMOKE, _deps_for_suite(), progress=False)
    out, err = capsys.readouterr()
    assert out == "" and err == ""
