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
from trajectory_io import describe_final

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
    submitted_category: str | None = None
    submitted_priority: str | None = None

    for _step_no, tool_calls, results_summary in step_rows:
        calls = _as_list(tool_calls)
        steps.append([c.get("name", "") for c in calls])
        for c in calls:
            name = c.get("name", "")
            args = c.get("args", {}) or {}
            if name == "triage_ticket":
                submitted_citations.extend(args.get("citations", []) or [])
                escalated = escalated or bool(args.get("escalated"))
                submitted_category = args.get("category") or submitted_category
                submitted_priority = args.get("priority") or submitted_priority
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
        submitted_category=submitted_category,
        submitted_priority=submitted_priority,
    )


def _as_list(v) -> list[dict]:
    if v is None:
        return []
    if isinstance(v, str):
        v = json.loads(v)
    return v if isinstance(v, list) else []


def _extract_ids(summary: str) -> set[str]:
    """Chunk/ticket ids as the tools write them into agent_steps summaries.

    Policy chunks are "chunk-" plus one or more dash-separated segments
    (chunk-qle-12 from chunk_key, chunk-312 from the serial-id fallback);
    resolved tickets are R-nnnn.
    """
    import re

    return set(re.findall(r"\b(?:chunk-[a-z0-9]+(?:-[a-z0-9]+)*|R-\d+)\b", summary))


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

What the agent did: {outcome}

Score the reasoning from 0.0 to 1.0 on whether it follows the rubric and is
grounded in evidence rather than assertion. Respond with ONLY a JSON object:
{{"score": <float>, "reason": "<one sentence>"}}"""

# A separate rubric for the cases the agent is supposed to refuse.
#
# The shared prompt scores "grounded in evidence rather than assertion", which
# is exactly backwards for an out-of-scope ticket: there is no evidence to cite,
# and recognising that is the correct answer. On the first full nightly the
# judge failed oos-04 with "the reasoning is based on an assertion that
# performance management is out of scope ... rather than evidence-based" — a
# verbatim description of the right behaviour, scored 0.0.
ESCALATION_JUDGE_PROMPT = """You are grading a benefits-triage agent on a ticket
it was SUPPOSED to hand off to a human, because the benefits corpus does not
cover it.

Ticket: {subject}
{body}

Rubric for a correct approach: {rubric}

The agent's reasoning across the run:
{scratchpad}

What the agent did: {outcome}

The correct behaviour here is to recognise that the corpus does not answer this
ticket and escalate. Stating that the subject is out of scope is the right
conclusion, NOT an unsupported assertion — do not penalise it for lacking
citations, because there are none to give.

Score from 0.0 to 1.0 on whether the agent reached the hand-off for a sound
reason and avoided answering from evidence it did not have. An agent that
answered the ticket anyway, or that escalated for a confused reason, scores low.
Respond with ONLY a JSON object:
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
    # A case with no expected grounding ids is one the agent must refuse; the
    # same test test_golden_consistency.py uses to identify them.
    escalation_case = not case.outcome.grounding_ids
    template = ESCALATION_JUDGE_PROMPT if escalation_case else JUDGE_PROMPT
    default_rubric = (
        "The agent should recognise the ticket is outside the benefits corpus and hand it off."
        if escalation_case
        else "Reasoning should be evidence-based and coherent."
    )
    prompt = template.format(
        subject=case.subject,
        body=case.body,
        rubric=case.reasoning_rubric or default_rubric,
        scratchpad=scratchpad or "(none)",
        # Stated in words as well as JSON: a local judge handed
        # {"tool": "escalate_to_human"} still claimed the agent had not escalated.
        outcome=f"{describe_final(final)}\n\nRaw terminal arguments: {json.dumps(final)}",
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
    """Defaults to a local llama judge against a Claude worker.

    The previous default, gpt-4o-mini, needed an OpenAI key this project has
    never had, so --suite nightly could not run as shipped. llama3.1 is a
    different family from the worker (which is the constraint that matters),
    already installed for the fallback provider, and free — so the judge costs
    nothing and the separation is real rather than nominal.
    """
    worker_family = os.environ.get("AGENT_WORKER_FAMILY", "claude")
    judge_model = os.environ.get("EVAL_JUDGE_MODEL", "llama3.1")
    judge_family = os.environ.get("EVAL_JUDGE_FAMILY", "llama")
    return JudgeConfig(worker_family, judge_model, judge_family)
