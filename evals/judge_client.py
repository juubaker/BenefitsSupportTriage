"""Judge-model clients for the trajectory judge.

reasoning_quality() takes `judge_call(prompt) -> str` so it stays provider
agnostic and stub-testable. This module supplies real implementations; wiring.py
picks one. Nothing here parses the judge's answer — reasoning_quality already
handles unparseable output as a failed metric, which is the right outcome.

Judge-model separation (spec §8) is enforced by JudgeConfig.validate(), not
here: with Claude as the worker, a Claude judge is refused, because a model
grading its own family inflates the score it is there to check. Locally that
leaves Ollama, which is free and a genuinely different family.

    EVAL_JUDGE_MODEL   default llama3.1
    EVAL_JUDGE_FAMILY  default llama   (must differ from AGENT_WORKER_FAMILY)
    OLLAMA_BASE_URL    default http://localhost:11434
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


class JudgeUnavailable(RuntimeError):
    """The judge model could not be reached or is not installed."""


def make_ollama_judge(
    model: str | None = None,
    base_url: str | None = None,
    timeout: float = 120.0,
):
    """Return judge_call(prompt) -> str backed by Ollama's chat endpoint.

    format=json asks for a bare JSON object, which is what JUDGE_PROMPT
    demands; temperature 0 makes repeated runs as comparable as an LLM judge
    can be. Scores remain somewhat stochastic, which is why the metric
    threshold sits at 0.6 rather than 1.0.
    """
    model = model or os.environ.get("EVAL_JUDGE_MODEL", "llama3.1")
    base_url = (base_url or os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")).rstrip("/")

    def judge_call(prompt: str) -> str:
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0},
        }
        req = urllib.request.Request(
            f"{base_url}/api/chat",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = json.load(resp)
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:200]
            # A missing model is the common case and reads as a generic 404
            # without this: `ollama pull <model>` is the fix.
            raise JudgeUnavailable(
                f"judge model {model!r} rejected by {base_url} ({err.code}): {detail}. "
                f"If it is not installed, run `ollama pull {model}`."
            ) from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise JudgeUnavailable(
                f"judge model {model!r} unreachable at {base_url}: {err}. "
                "Start it with `ollama serve`."
            ) from err
        return (body.get("message") or {}).get("content", "")

    return judge_call


def make_judge_call(**kwargs):
    """The judge the suite uses by default. Ollama today; swap here, not in
    wiring.py, so the choice stays under test."""
    return make_ollama_judge(**kwargs)
