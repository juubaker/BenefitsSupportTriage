"""Eval runner + CI gate (spec §8).

  python -m eval.run --suite smoke     # PR gate: deterministic only, exit 1 on regression
  python -m eval.run --suite nightly   # full 40 + judge metrics, writes scorecard

  python -m eval.run --suite nightly --provider anthropic   # pin the model under test

The scorecard records which provider actually generated the tokens, and the
gate fails on a silent fallback. Both exist because every scorecard produced
before this read as a Claude result and was in fact llama3.1: the server failed
over on its first API call and the runner never asked what answered. Pass
--allow-failover only when a mixed-provider scorecard is genuinely wanted.

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
import time
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
    # What the run asked for vs what actually generated the tokens. Defaulted
    # so existing callers and tests keep working; filled by execute_suite.
    requested_provider: str = ""
    observed_providers: tuple[str, ...] = ()


def observed_providers(conn, run_id: str) -> tuple[str, str, tuple[str, ...]]:
    """What provider was asked for, and what actually did the work.

    agent_runs.provider is set once at createRun and never updated, so after a
    failover the run row still says "anthropic" while every step was generated
    by the fallback. token_ledger carries the provider per step, which is the
    authoritative record. Returns (requested, requested_model, observed).

    This is why the whole 42-case suite has been scoring llama3.1 while the
    scorecard said nothing: the runner never asked which model answered.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT r.provider, r.model, "
            "       array_remove(array_agg(DISTINCT l.provider), NULL) "
            "FROM agent_runs r LEFT JOIN token_ledger l ON l.run_id = r.id "
            "WHERE r.id = %s GROUP BY r.id, r.provider, r.model",
            (run_id,),
        )
        row = cur.fetchone()
    if not row:
        return "", "", ()
    requested, model, observed = row
    return requested or "", model or "", tuple(sorted(observed or ()))


def preflight(deps: "RunnerDeps") -> str | None:
    """Check the app and the DB answer before spending a suite on finding out.

    A wrong APP_URL surfaced as eighty lines of urllib3 traceback on case one,
    with the actual problem — port 3000 in wiring.py against a server on 3001 —
    named only in the innermost frame. Returns a one-line problem description,
    or None when everything answers.
    """
    import os as _os

    app_url = _os.environ.get("AGENT_APP_URL", "http://localhost:3001")

    try:
        with deps.conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM policy_chunks")
            chunks = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM resolved_tickets")
            tickets = cur.fetchone()[0]
    except Exception as err:  # noqa: BLE001 — any DB failure is the same answer here
        return f"database unreachable or un-migrated: {type(err).__name__}: {err}"
    if chunks == 0:
        return "policy_chunks is empty — run the rag ingest before scoring retrieval"

    try:
        import requests  # type: ignore

        resp = requests.get(f"{app_url}/api/health", timeout=5)
    except Exception as err:  # noqa: BLE001
        return (
            f"app unreachable at {app_url} ({type(err).__name__}). "
            "Set AGENT_APP_URL to the port the server actually listens on "
            "(the dev server defaults to 3001, wiring.py's default is 3000), "
            "and check that `npm run dev` is up."
        )
    if resp.status_code != 200:
        return f"{app_url}/api/health returned {resp.status_code}"

    health = {}
    try:
        health = resp.json()
    except ValueError:
        pass
    agent = health.get("agent") or {}
    if agent and agent.get("mounted") is False:
        return (
            f"the agent is not mounted on {app_url} — POST /api/triage would answer 503. "
            "Run `npm run agent:build`, then restart the server."
        )
    providers = agent.get("providers") or []
    if deps.provider and providers and deps.provider not in providers:
        return (
            f"--provider {deps.provider} is not configured on the server "
            f"(it reports {providers}). Every case would fail on a pinned provider "
            "that does not exist."
        )

    print(
        f"preflight ok — app {app_url}, providers {providers or 'unreported'}, "
        f"{chunks} policy chunks, {tickets} resolved tickets"
        + (f", pinned to {deps.provider}" if deps.provider else "")
    )
    return None


def _traceparent(trace_id: str, span_id: str) -> str:
    return f"00-{trace_id}-{span_id}-01"


def run_case(case: GoldenCase, deps: "RunnerDeps") -> tuple[str, list[MetricResult]]:
    """Execute one agent run and score it. Returns (run_id, results)."""
    trace_id = uuid.uuid4().hex  # 32 hex chars
    span_id = uuid.uuid4().hex[:16]
    payload = {"ticketId": case.id, "subject": case.subject, "body": case.body}
    # Pinning is not just bookkeeping: the harness only fails over when the
    # caller left the provider unset, so a pinned run surfaces a provider
    # error as a failed run instead of quietly scoring the fallback.
    if getattr(deps, "provider", None):
        payload["provider"] = deps.provider
    run_id = deps.trigger_run(payload, traceparent=_traceparent(trace_id, span_id))
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
        # The detail string, not just the metric name: a scorecard that says
        # "outcome_correctness failed" and nothing else sends you to the DB to
        # find out what the run actually decided. MetricResult already carries
        # the explanation; it was being dropped on the way out.
        "failures": [
            {
                "case_id": s.case_id,
                "failed": [
                    {"metric": m["metric"], "score": m["score"], "detail": m["detail"]}
                    for m in s.metrics
                    if not m["passed"]
                ],
            }
            for s in scores
            if not s.passed
        ],
        # A scorecard that does not name the model it measured is not evidence
        # of anything. "failed_over" lists the cases whose tokens came from a
        # provider other than the one requested.
        "providers": {
            "requested": sorted({s.requested_provider for s in scores if s.requested_provider}),
            "observed": sorted({p for s in scores for p in s.observed_providers}),
            "failed_over": [
                s.case_id
                for s in scores
                if s.requested_provider
                and s.observed_providers
                and set(s.observed_providers) != {s.requested_provider}
            ],
        },
    }


@dataclass
class RunnerDeps:
    conn: object
    trigger_run: object  # (payload, traceparent) -> run_id
    with_judge: bool
    judge_call: object = None
    judge_cfg: object = None
    load_scratch_and_final: object = None
    # Set by main() from --provider; wiring.py does not need to know about it,
    # since the payload passes straight through to POST /api/triage.
    provider: str | None = None


def execute_suite(
    suite: Suite,
    deps: RunnerDeps,
    golden_dir: str | None = None,
    progress: bool = True,
) -> dict:
    """Run and score every case in the suite.

    Progress goes to stderr per case. A nightly suite is 42 real model runs
    plus 42 judge calls — half an hour or more — and printing nothing until the
    end is indistinguishable from a hang. stderr keeps stdout a clean JSON
    document for anything piping the scorecard.
    """
    cases = load_suite(suite, golden_dir)
    scores: list[CaseScore] = []
    judge_model = deps.judge_cfg.judge_model if (deps.with_judge and deps.judge_cfg) else None
    total = len(cases)
    started = time.monotonic()

    for i, case in enumerate(cases, 1):
        if progress:
            print(f"[{i}/{total}] {case.id} ...", end="", flush=True, file=sys.stderr)
        case_began = time.monotonic()
        run_id, results = run_case(case, deps)
        persist_results(deps.conn, run_id, suite.value, case.id, results, judge_model)
        case_passed = all(r.passed for r in results)
        requested, _model, observed = observed_providers(deps.conn, run_id)
        scores.append(
            CaseScore(
                case_id=case.id,
                bucket=case.bucket.value,
                run_id=run_id,
                metrics=[asdict(r) for r in results],
                passed=case_passed,
                requested_provider=requested,
                observed_providers=observed,
            )
        )
        if progress:
            elapsed = time.monotonic() - case_began
            failed = [r.metric for r in results if not r.passed]
            # The failing metric names go out live: on a long suite you want to
            # know it is going wrong at case 3, not at minute 40.
            verdict = "ok" if case_passed else "FAIL " + ",".join(failed)
            eta = (time.monotonic() - started) / i * (total - i)
            print(
                f" {verdict} ({elapsed:.0f}s, ~{eta / 60:.0f}m left)",
                flush=True,
                file=sys.stderr,
            )

    if progress:
        print(
            f"done: {sum(1 for s in scores if s.passed)}/{total} in "
            f"{(time.monotonic() - started) / 60:.1f}m",
            file=sys.stderr,
        )
    return build_scorecard(scores, suite.value)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", choices=[s.value for s in Suite], default="smoke")
    parser.add_argument("--out", default="eval/scorecards/latest.json")
    parser.add_argument("--min-pass-rate", type=float, default=1.0,
                        help="fail the process if case pass rate drops below this")
    parser.add_argument("--provider", choices=["anthropic", "ollama"], default=None,
                        help="pin every run to this provider instead of taking the server "
                             "default. A pinned run does not fail over, so a provider error "
                             "fails the case rather than being scored on the fallback.")
    parser.add_argument("--skip-preflight", action="store_true",
                        help="run the suite without first checking that the app and DB answer")
    parser.add_argument("--allow-failover", action="store_true",
                        help="score a suite whose runs fell back to another provider. "
                             "Off by default: a mixed-provider scorecard measures nothing, "
                             "and a silent fallback is how 42 cases came to be scored on "
                             "llama3.1 while the scorecard read as a Claude result.")
    args = parser.parse_args(argv)
    suite = Suite(args.suite)

    # Wiring left to the deployment: construct psycopg conn, an HTTP trigger to
    # POST /api/triage (returning the run_id from the run_started event), and —
    # for nightly — the judge_call closure. See eval/README.md.
    from wiring import build_runner_deps  # type: ignore

    deps = build_runner_deps(with_judge=(suite is Suite.NIGHTLY))
    # Assigned rather than passed, so an existing wiring.py keeps its signature.
    deps.provider = args.provider

    if not args.skip_preflight:
        problem = preflight(deps)
        if problem:
            print(f"PREFLIGHT FAILED: {problem}", file=sys.stderr)
            return 2

    scorecard = execute_suite(suite, deps)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(scorecard, f, indent=2, sort_keys=True)

    print(json.dumps(scorecard, indent=2))

    # Checked before the pass rate: a suite that ran on the wrong model has no
    # pass rate worth reporting, whichever way it came out.
    failed_over = scorecard["providers"]["failed_over"]
    if failed_over and not args.allow_failover:
        print(
            f"\nGATE FAILED: {len(failed_over)} of {scorecard['cases']} cases fell back from "
            f"{scorecard['providers']['requested']} to another provider "
            f"(observed: {scorecard['providers']['observed']}).\n"
            f"First affected: {', '.join(failed_over[:5])}\n"
            "The server log and the provider_failover event carry the reason; "
            "`cd agent && npm run provider-check` reproduces it directly.\n"
            "Re-run with --allow-failover only if a mixed-provider scorecard is what you want.",
            file=sys.stderr,
        )
        return 1

    rate = scorecard["case_pass_rate"]
    if rate < args.min_pass_rate:
        print(f"\nGATE FAILED: pass rate {rate} < {args.min_pass_rate}", file=sys.stderr)
        return 1
    observed = scorecard["providers"]["observed"] or ["unknown"]
    print(f"\nGATE PASSED: pass rate {rate} >= {args.min_pass_rate} on {', '.join(observed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
