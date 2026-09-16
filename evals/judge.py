"""
LLM-as-judge configuration for DeepEval metrics.

Uses the Anthropic API as the judge, consistent with the triage agent's
own provider. Keeping the judge model separate from the agent's model is
deliberate: it reduces (though doesn't eliminate) self-preference bias,
which is worth mentioning when discussing eval methodology in interviews.

Requires ANTHROPIC_API_KEY in the environment.
"""

import os

from deepeval.models import AnthropicModel

JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "claude-sonnet-4-5")


def get_judge() -> AnthropicModel:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise EnvironmentError(
            "ANTHROPIC_API_KEY is not set. Export it or add it to evals/.env "
            "before running the eval suite."
        )
    # temperature=0 for deterministic-as-possible judging; LLM-as-judge
    # scores are still somewhat stochastic, which is why thresholds in
    # test_rag_metrics.py are set with headroom rather than at 1.0.
    return AnthropicModel(model=JUDGE_MODEL, temperature=0)
