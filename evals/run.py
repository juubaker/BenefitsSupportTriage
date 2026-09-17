"""Eval runner + CI gate (spec §8).

  python -m eval.run --suite smoke     # PR gate: deterministic only, exit 1 on regression
  python -m eval.run --suite nightly   # full 40 + judge metrics, writes scorecard

Flow per case: trigger a real agent run via the harness HTTP endpoint (originating
a W3C traceparent so the run's spans link back here), read the persisted RunData,
score it, persist eval_results rows, and aggregate a scorecard. The scorecard is
a committed artifact so regressions diff across commits.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from dataclasses import asdict, dataclass

from cases import GoldenCase, Suite, load_suite
from trajectory_judge import default_judge_config, load_run_data, reasoning_quality
from metrics import MetricResult, score_deterministic


@dataclass
class CaseScore:
    case_id: str
    bucket: str
    run_id: str
    metrics: list[dict]
    passed: bool


def _traceparent(trace_id: str, span_id: str) -> str:
    return f"00-{trace_id}-{span_id}-01"


def run_case(case: GoldenCase, deps: "RunnerDeps") -> tuple[str, list[MetricResult]]:
    """Execute one agent run and score it. Returns (run_id, results)."""
    trace_id = uuid.uuid4().hex  # 32 hex chars
    span_id = uuid.uuid4().hex[:16]
    run_id = deps.trigger_run(
        {"ticketId": case.id, "subject": case.subject, "body": case.body},
        traceparent=_traceparent(trace_id, span_id),
    )
    run = load_run_data(deps.conn, run_id)
    results = score_deterministic(case, run)

    if deps.with_judge:
        scratch, final = deps.load_scratch_and_final(run_id)
        results.append(
            reasoning_quality(case, scratch, final, deps.judge_call, deps.judge_cfg)
        )
    return run_id, results


def persist_results(conn, run_id: str, suite: str, case_id: str, results: list[MetricResult], judge_model: str | None):
    with conn.cursor() as cur:
        for r in results:
            cur.execute(
                "INSERT INTO eval_results (run_id, suite, case_id, metric, score, passed, judge_model) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (run_id, suite, case_id, r.metric, r.score, r.passed,
                 judge_model if r.metric == "reasoning_quality" else None),
            )
    conn.commit()


def build_scorecard(scores: list[CaseScore], suite: str) -> dict:
    total = len(scores)
    passed = sum(1 for s in scores if s.passed)
    by_metric: dict[str, dict[str, int]] = {}
    by_bucket: dict[str, dict[str, int]] = {}
    for s in scores:
        b = by_bucket.setdefault(s.bucket, {"pass": 0, "total": 0})
        b["total"] += 1
        b["pass"] += int(s.passed)
        for m in s.metrics:
            entry = by_metric.setdefault(m["metric"], {"pass": 0, "total": 0})
            entry["total"] += 1
            entry["pass"] += int(m["passed"])
    return {
        "suite": suite,
        "cases": total,
        "cases_passed": passed,
        "case_pass_rate": round(passed / total, 3) if total else 0.0,
        "by_metric": {
            k: {**v, "rate": round(v["pass"] / v["total"], 3)} for k, v in sorted(by_metric.items())
        },
        "by_bucket": {
            k: {**v, "rate": round(v["pass"] / v["total"], 3)} for k, v in sorted(by_bucket.items())
        },
        "failures": [
            {"case_id": s.case_id, "failed": [m["metric"] for m in s.metrics if not m["passed"]]}
            for s in scores
            if not s.passed
        ],
    }


@dataclass
class RunnerDeps:
    conn: object
    trigger_run: object  # (payload, traceparent) -> run_id
    with_judge: bool
    judge_call: object = None
    judge_cfg: object = None
    load_scratch_and_final: object = None


def execute_suite(suite: Suite, deps: RunnerDeps, golden_dir: str | None = None) -> dict:
    cases = load_suite(suite, golden_dir)
    scores: list[CaseScore] = []
    judge_model = deps.judge_cfg.judge_model if (deps.with_judge and deps.judge_cfg) else None

    for case in cases:
        run_id, results = run_case(case, deps)
        persist_results(deps.conn, run_id, suite.value, case.id, results, judge_model)
        case_passed = all(r.passed for r in results)
        scores.append(
            CaseScore(
                case_id=case.id,
                bucket=case.bucket.value,
                run_id=run_id,
                metrics=[asdict(r) for r in results],
                passed=case_passed,
            )
        )
    return build_scorecard(scores, suite.value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", choices=[s.value for s in Suite], default="smoke")
    parser.add_argument("--out", default="eval/scorecards/latest.json")
    parser.add_argument("--min-pass-rate", type=float, default=1.0,
                        help="fail the process if case pass rate drops below this")
    args = parser.parse_args(argv)
    suite = Suite(args.suite)

    # Wiring left to the deployment: construct psycopg conn, an HTTP trigger to
    # POST /api/triage (returning the run_id from the run_started event), and —
    # for nightly — the judge_call closure. See eval/README.md.
    from wiring import build_runner_deps  # type: ignore

    deps = build_runner_deps(with_judge=(suite is Suite.NIGHTLY))
    scorecard = execute_suite(suite, deps)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(scorecard, f, indent=2, sort_keys=True)

    print(json.dumps(scorecard, indent=2))
    rate = scorecard["case_pass_rate"]
    if rate < args.min_pass_rate:
        print(f"\nGATE FAILED: pass rate {rate} < {args.min_pass_rate}", file=sys.stderr)
        return 1
    print(f"\nGATE PASSED: pass rate {rate} >= {args.min_pass_rate}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
