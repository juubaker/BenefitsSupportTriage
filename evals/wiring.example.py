"""Deployment wiring for eval/run.py (copy to wiring.py and fill in).

Kept separate so the harness core stays import-clean in CI unit tests. run.py
imports `build_runner_deps` from `wiring` only at actual run time.
"""
from __future__ import annotations

import os
import time

import psycopg  # type: ignore
import requests  # type: ignore

from judge import default_judge_config
from run import RunnerDeps

APP_URL = os.environ.get("AGENT_APP_URL", "http://localhost:3000")
DB_URL = os.environ["DATABASE_URL"]


def _trigger_run(payload: dict, traceparent: str) -> str:
    """POST /api/triage, read SSE, return the run_id from run_started."""
    run_id = ""
    with requests.post(
        f"{APP_URL}/api/triage",
        json=payload,
        headers={"traceparent": traceparent, "Accept": "text/event-stream"},
        stream=True,
        timeout=300,
    ) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines(decode_unicode=True):
            if line and line.startswith("data:"):
                import json
                data = json.loads(line[5:].strip())
                if data.get("type") == "run_started" and not run_id:
                    run_id = data["runId"]
                if data.get("type") == "terminal":
                    break
    if not run_id:
        raise RuntimeError("no run_id observed from /api/triage stream")
    # give the harness a beat to flush the final finishRun write
    time.sleep(0.5)
    return run_id


def _load_scratch_and_final(conn, run_id: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT scratchpad, tool_calls FROM agent_steps WHERE run_id=%s ORDER BY step_no",
            (run_id,),
        )
        rows = cur.fetchall()
    scratch = "\n".join(r[0] for r in rows if r[0])
    final = {}
    for _s, calls in rows:
        for c in (calls or []):
            if c.get("name") == "triage_ticket":
                final = c.get("args", {})
    return scratch, final


def _judge_call(prompt: str) -> str:
    """Call the judge model — different family than the worker (spec §8).
    Swap this body for your OpenAI/Anthropic/other client as configured."""
    raise NotImplementedError("wire your judge model client here")


def build_runner_deps(with_judge: bool) -> RunnerDeps:
    conn = psycopg.connect(DB_URL)
    return RunnerDeps(
        conn=conn,
        trigger_run=_trigger_run,
        with_judge=with_judge,
        judge_call=_judge_call if with_judge else None,
        judge_cfg=default_judge_config() if with_judge else None,
        load_scratch_and_final=(lambda rid: _load_scratch_and_final(conn, rid)) if with_judge else None,
    )
