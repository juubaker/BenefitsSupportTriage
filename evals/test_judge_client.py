"""Tests for the trajectory judge's client and family separation.

Split out of test_eval.py: the judge is a distinct seam (an injected
judge_call plus a config that refuses same-family judging), and keeping it
in its own file stops every change here from touching the one big file.

Run: cd evals && python -m pytest test_judge_client.py -q
"""

from __future__ import annotations

import pytest

from cases import load_cases


def case_by_id(cid: str):
    return next(c for c in load_cases() if c.id == cid)

def test_judge_config_default_pairs_a_llama_judge_with_a_claude_worker(monkeypatch):
    # The old default (gpt-4o-mini) needed a key this project never had, so
    # --suite nightly could not run as shipped.
    for var in ("AGENT_WORKER_FAMILY", "EVAL_JUDGE_MODEL", "EVAL_JUDGE_FAMILY"):
        monkeypatch.delenv(var, raising=False)
    from trajectory_judge import default_judge_config
    cfg = default_judge_config()
    assert (cfg.worker_family, cfg.judge_model, cfg.judge_family) == ("claude", "llama3.1", "llama")
    cfg.validate()  # must not raise


def test_judge_config_still_refuses_a_same_family_judge(monkeypatch):
    monkeypatch.setenv("AGENT_WORKER_FAMILY", "llama")
    from trajectory_judge import default_judge_config
    with pytest.raises(ValueError, match="must differ"):
        default_judge_config().validate()


def test_ollama_judge_returns_the_message_content(monkeypatch):
    import io
    import json as _json
    import judge_client

    captured = {}
    inner = _json.dumps({"score": 0.9})
    envelope = _json.dumps({"message": {"content": inner}})

    def _urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["body"] = _json.loads(req.data)
        return io.StringIO(envelope)

    monkeypatch.setattr(judge_client.urllib.request, "urlopen", _urlopen)
    call = judge_client.make_ollama_judge(model="llama3.1", base_url="http://x:11434/")
    assert call("grade this") == inner
    assert captured["url"] == "http://x:11434/api/chat"
    # format=json and temperature 0 are what make repeated runs comparable.
    assert captured["body"]["format"] == "json"
    assert captured["body"]["options"]["temperature"] == 0
    assert captured["body"]["stream"] is False
    assert captured["body"]["model"] == "llama3.1"


def test_ollama_judge_names_the_pull_command_when_the_model_is_missing(monkeypatch):
    import io
    import urllib.error
    import judge_client

    def _urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 404, "not found", {}, io.BytesIO(b"model not found")
        )

    monkeypatch.setattr(judge_client.urllib.request, "urlopen", _urlopen)
    call = judge_client.make_ollama_judge(model="missing-model")
    with pytest.raises(judge_client.JudgeUnavailable, match="ollama pull missing-model"):
        call("grade this")


def test_ollama_judge_names_ollama_serve_when_nothing_is_listening(monkeypatch):
    import judge_client, urllib.error

    def _urlopen(req, timeout=None):
        raise urllib.error.URLError("Connection refused")

    monkeypatch.setattr(judge_client.urllib.request, "urlopen", _urlopen)
    with pytest.raises(judge_client.JudgeUnavailable, match="ollama serve"):
        judge_client.make_ollama_judge()("grade this")


def test_unparseable_judge_output_is_a_failed_metric_not_a_crash():
    # The client deliberately does not parse; this is where bad output lands.
    from trajectory_judge import reasoning_quality, JudgeConfig
    case = case_by_id("base-01")
    res = reasoning_quality(case, "thinking", {}, lambda _p: "I think it is fine",
                            JudgeConfig("claude", "llama3.1", "llama"))
    assert res.passed is False
    assert "unparseable" in res.detail

