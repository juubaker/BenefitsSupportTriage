"""What the trajectory judge is shown about a run.

This lived in wiring.py, which is gitignored, so a bug in it was invisible to
the repo and to every test. It had one: it collected the arguments of
triage_ticket and nothing else, so for a case that ends in escalate_to_human
the judge received an empty final decision. On the first full nightly the judge
failed oos-01 with "the agent ... did not escalate" while escalation_correctness
scored it 40/40 — the agent escalated, and the judge was simply never told.

Keeping this here means the judge's input is reviewable and testable.
"""

from __future__ import annotations

TERMINAL_TOOLS = ("triage_ticket", "escalate_to_human")


def load_scratch_and_final(conn, run_id: str) -> tuple[str, dict]:
    """Return (scratchpad, final decision) for a run.

    The final decision is the arguments of whichever terminal tool ended the
    run, tagged with which one it was so the judge can tell an answer from a
    hand-off. The last terminal call wins: a run that was nudged into a final
    answer can contain an earlier rejected attempt.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT scratchpad, tool_calls FROM agent_steps WHERE run_id=%s ORDER BY step_no",
            (run_id,),
        )
        rows = cur.fetchall()

    scratch = "\n".join(r[0] for r in rows if r[0])
    final: dict = {}
    for _scratch, calls in rows:
        for call in calls or []:
            name = call.get("name")
            if name in TERMINAL_TOOLS:
                final = {"tool": name, **(call.get("args") or {})}
    return scratch, final


def describe_final(final: dict) -> str:
    """One line stating what the run actually did, for the judge prompt.

    Spelled out in words rather than left for the judge to infer from a JSON
    blob: a local judge model reading {"tool": "escalate_to_human", ...} was
    still asserting the agent had not escalated.
    """
    if not final:
        return "The agent reached no terminal decision (the run ended without one)."
    tool = final.get("tool")
    if tool == "escalate_to_human":
        reason = final.get("reason") or "(no reason given)"
        return f"The agent ESCALATED to a human rather than answering. Reason given: {reason}"
    if tool == "triage_ticket":
        cites = final.get("citations") or []
        return (
            "The agent ANSWERED the ticket, filing "
            f"category={final.get('category')!r} priority={final.get('priority')!r} "
            f"citing {list(cites)}. Summary: {final.get('summary')!r}"
        )
    return f"The agent finished with {tool!r}: {final}"
