"""RunData assembly from Postgres, and the judge-model reasoning metric (spec §8).

load_run_data() projects the persisted agent_steps/token_ledger rows into the
RunData the deterministic metrics consume. reasoning_quality() is the ONE
LLM-judge metric; it uses a model from a DIFFERENT family than the worker
(judge-model separation carried from v1) and runs nightly only.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

from cases import GoldenCase
from metrics import MetricResult, RunData

TERMINAL_TOOLS = {"triage_ticket", "escalate_to_human"}


def load_run_data(conn, run_id: str) -> RunData:
    """conn is a psycopg connection. Reassembles one run from the tables."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT terminal_state, step_count, total_input_tokens, total_output_tokens "
            "FROM agent_runs WHERE id = %s",
            (run_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"run not found: {run_id}")
        terminal_state, step_count, in_tok, out_tok = row

        cur.execute(
            "SELECT step_no, tool_calls, tool_results_summary FROM agent_steps "
            "WHERE run_id = %s ORDER BY step_no",
            (run_id,),
        )
        step_rows = cur.fetchall()

    steps: list[list[str]] = []
    submitted_citations: list[str] = []
    observed_ids: set[str] = set()
    escalated = False

    for _step_no, tool_calls, results_summary in step_rows:
        calls = _as_list(tool_calls)
        steps.append([c.get("name", "") for c in calls])
        for c in calls:
            name = c.get("name", "")
            args = c.get("args", {}) or {}
            if name == "triage_ticket":
                submitted_citations.extend(args.get("citations", []) or [])
                escalated = escalated or bool(args.get("escalated"))
            elif name == "escalate_to_human":
                escalated = True
        # observed ids come from the tool-result summaries persisted per step
        for r in _as_list(results_summary):
            observed_ids.update(_extract_ids(r.get("summary", "")))

    return RunData(
        terminal_state=terminal_state,
        step_count=step_count,
        total_tokens=(in_tok or 0) + (out_tok or 0),
        steps=steps,
        submitted_citations=submitted_citations,
        observed_ids=observed_ids,
        escalated=escalated,
    )


def _as_list(v) -> list[dict]:
    if v is None:
        return []
    if isinstance(v, str):
        v = json.loads(v)
    return v if isinstance(v, list) else []


def _extract_ids(summary: str) -> set[str]:
    """Chunk/ticket ids look like chunk-xxx-nn or R-nnnn in the summaries."""
    import re

    return set(re.findall(r"\b(?:chunk-[a-z0-9]+-\d+|R-\d+)\b", summary))


# ---------------------------------------------------------------------------
# Judge metric (nightly only)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class JudgeConfig:
    # Enforce judge-model separation in one place (spec §8).
    worker_family: str  # e.g. "claude" or "llama"
    judge_model: str    # must be a different family, e.g. "gpt-4o-mini" when worker is claude
    judge_family: str

    def validate(self) -> None:
        if self.judge_family == self.worker_family:
            raise ValueError(
                f"judge family ({self.judge_family}) must differ from worker "
                f"family ({self.worker_family}) — judge-model separation"
            )


JUDGE_PROMPT = """You are grading a benefits-triage agent's reasoning.

Ticket: {subject}
{body}

Rubric for a correct approach: {rubric}

The agent's reasoning across the run:
{scratchpad}

The agent's final triage: {final}

Score the reasoning from 0.0 to 1.0 on whether it follows the rubric and is
grounded in evidence rather than assertion. Respond with ONLY a JSON object:
{{"score": <float>, "reason": "<one sentence>"}}"""


def reasoning_quality(
    case: GoldenCase,
    scratchpad: str,
    final: dict,
    judge_call,
    cfg: JudgeConfig,
    threshold: float = 0.6,
) -> MetricResult:
    """judge_call(prompt: str) -> str is injected so this stays provider-agnostic
    and unit-testable with a stub."""
    cfg.validate()
    prompt = JUDGE_PROMPT.format(
        subject=case.subject,
        body=case.body,
        rubric=case.reasoning_rubric or "Reasoning should be evidence-based and coherent.",
        scratchpad=scratchpad or "(none)",
        final=json.dumps(final),
    )
    raw = judge_call(prompt)
    try:
        parsed = json.loads(raw.strip().strip("`").removeprefix("json").strip())
        score = float(parsed["score"])
        reason = parsed.get("reason", "")
    except (json.JSONDecodeError, KeyError, ValueError):
        return MetricResult("reasoning_quality", 0.0, False, f"unparseable judge output: {raw[:80]}")
    return MetricResult("reasoning_quality", score, score >= threshold, reason)


def default_judge_config() -> JudgeConfig:
    worker_family = os.environ.get("AGENT_WORKER_FAMILY", "claude")
    judge_model = os.environ.get("EVAL_JUDGE_MODEL", "gpt-4o-mini")
    judge_family = os.environ.get("EVAL_JUDGE_FAMILY", "gpt")
    return JudgeConfig(worker_family, judge_model, judge_family)
