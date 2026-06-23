// server/llm/anthropic.js
// Anthropic provider — calls the Messages API.

import {
  CLASSIFY_SYSTEM,
  DRAFT_SYSTEM,
  buildClassifyPrompt,
  buildDraftPrompt,
} from './shared.js';

const DEFAULT_TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_DRAFT_MODEL = 'claude-sonnet-4-6';

async function callAnthropic({ apiKey, model, system, prompt, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function createAnthropicProvider(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const triageModel = env.ANTHROPIC_MODEL_TRIAGE || DEFAULT_TRIAGE_MODEL;
  const draftModel = env.ANTHROPIC_MODEL_DRAFT || DEFAULT_DRAFT_MODEL;

  function requireKey() {
    if (!apiKey) {
      throw new Error('Server missing ANTHROPIC_API_KEY. Set it in .env and restart.');
    }
  }

  return {
    name: 'anthropic',
    triageModel,
    draftModel,
    async classify({ title, body, categories }) {
      requireKey();
      return callAnthropic({
        apiKey,
        model: triageModel,
        system: CLASSIFY_SYSTEM,
        prompt: buildClassifyPrompt({ title, body, categories }),
        maxTokens: 300,
      });
    },
    async draft({ title, body }) {
      requireKey();
      return callAnthropic({
        apiKey,
        model: draftModel,
        system: DRAFT_SYSTEM,
        prompt: buildDraftPrompt({ title, body }),
        maxTokens: 600,
      });
    },
  async draftGrounded({ system, user }) {
      requireKey();
      return callAnthropic({
        apiKey,
        model: draftModel,
        system,
        prompt: user,
        maxTokens: 1024,
      });
    },
  };
}
