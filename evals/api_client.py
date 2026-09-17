"""
HTTP client for the Benefits Support Triage Agent.

Treats the agent as a black box: send a question, get back the answer
and the retrieval context (the pgvector chunks the agent actually used).

ADJUST THE TWO MARKED SECTIONS to match your Express API's request/response
shape. Everything else is stack-agnostic.
"""

import os
import time

import requests

BASE_URL = os.environ.get("TRIAGE_API_URL", "http://localhost:3000")
ENDPOINT = os.environ.get("TRIAGE_API_ENDPOINT", "/api/triage")
TIMEOUT_S = int(os.environ.get("TRIAGE_API_TIMEOUT", "60"))
RETRIES = 2


def ask_agent(question: str) -> dict:
    """
    Send one question to the triage agent.

    Returns:
        {
          "answer": str,                 # the agent's final answer text
          "retrieval_context": [str],    # the chunk texts retrieved from pgvector
          "latency_ms": float,
        }
    """
    # ------------------------------------------------------------------
    # ADJUST #1 — request shape.
    # If your endpoint expects e.g. {"message": ...} or a conversation
    # array, change the payload here.
    # ------------------------------------------------------------------
    payload = {"question": question}

    url = f"{BASE_URL}{ENDPOINT}"
    last_err = None
    for attempt in range(RETRIES + 1):
        try:
            start = time.perf_counter()
            resp = requests.post(url, json=payload, timeout=TIMEOUT_S)
            latency_ms = (time.perf_counter() - start) * 1000
            resp.raise_for_status()
            data = resp.json()

            # ----------------------------------------------------------
            # ADJUST #2 — response shape.
            # Map your API's JSON to (answer, retrieval_context).
            #
            # The important part for the RAG metrics: retrieval_context
            # must be the *actual chunk texts* the agent retrieved
            # (from policy_chunks / resolved_tickets), in the order
            # they were ranked. If your endpoint doesn't return them
            # yet, add them to the response — it's the single most
            # useful debugging surface a RAG API can expose, and it's
            # a good interview talking point in its own right.
            # ----------------------------------------------------------
            answer = data.get("answer") or data.get("response") or ""
            raw_chunks = data.get("sources") or data.get("chunks") or []
            retrieval_context = [
                c["text"] if isinstance(c, dict) else str(c) for c in raw_chunks
            ]

            return {
                "answer": answer,
                "retrieval_context": retrieval_context,
                "latency_ms": latency_ms,
            }
        except (requests.ConnectionError, requests.Timeout) as e:
            last_err = e
            if attempt < RETRIES:
                time.sleep(2**attempt)  # 1s, 2s backoff

    raise RuntimeError(
        f"Could not reach triage agent at {url} after {RETRIES + 1} attempts. "
        f"Is the Express server running? Last error: {last_err}"
    )


if __name__ == "__main__":
    # Smoke test: python api_client.py "your question here"
    import json
    import sys

    q = sys.argv[1] if len(sys.argv) > 1 else "When is open enrollment?"
    result = ask_agent(q)
    print(json.dumps(result, indent=2)[:2000])
