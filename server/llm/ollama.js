// server/llm/ollama.js
// Ollama provider — calls a local Ollama runtime (default localhost:11434).
//
// Required: Ollama installed and running locally, with at least one model
// pulled. Recommended:
//   ollama pull qwen2.5:7b        # ~4.7GB, good general-purpose
//   ollama pull llama3.2:3b       # ~2GB, faster on modest hardware
//
// Configure via env:
//   LLM_PROVIDER=ollama
//   OLLAMA_HOST=http://localhost:11434
//   OLLAMA_MODEL_TRIAGE=qwen2.5:7b
//   OLLAMA_MODEL_DRAFT=qwen2.5:7b

import {
  CLASSIFY_SYSTEM,
  DRAFT_SYSTEM,
  buildClassifyPrompt,
  buildDraftPrompt,
} from './shared.js';

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_TRIAGE_MODEL = 'qwen2.5:7b';
const DEFAULT_DRAFT_MODEL = 'qwen2.5:7b';

async function callOllama({ host, model, system, prompt, jsonMode = false, options = {} }) {
  const url = `${host.replace(/\/+$/, '')}/api/chat`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        // JSON mode constrains output to valid JSON. Useful for classify,
        // not for draft (we want prose, not a JSON object).
        ...(jsonMode ? { format: 'json' } : {}),
        options: {
          // Lower temperature = more deterministic, better for classification
          temperature: jsonMode ? 0.1 : 0.4,
          ...options,
        },
      }),
    });
  } catch (e) {
    // Connection refused, DNS failure, etc. Surface with a clearer message.
    throw new Error(
      `Ollama unreachable at ${host}. Is the Ollama runtime running? (${e.message})`
    );
  }

  if (!res.ok) {
    const errText = await res.text();
    // 404 from Ollama usually means the model isn't pulled yet
    if (res.status === 404 && /model.*not found/i.test(errText)) {
      throw new Error(
        `Ollama model "${model}" is not pulled. Run: ollama pull ${model}`
      );
    }
    throw new Error(`Ollama ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.message?.content ?? '';
}

export function createOllamaProvider(env = process.env) {
  const host = env.OLLAMA_HOST || DEFAULT_HOST;
  const triageModel = env.OLLAMA_MODEL_TRIAGE || DEFAULT_TRIAGE_MODEL;
  const draftModel = env.OLLAMA_MODEL_DRAFT || DEFAULT_DRAFT_MODEL;

  return {
    name: 'ollama',
    triageModel,
    draftModel,
    async classify({ title, body, categories }) {
      return callOllama({
        host,
        model: triageModel,
        system: CLASSIFY_SYSTEM,
        prompt: buildClassifyPrompt({ title, body, categories }),
        jsonMode: true,
      });
    },
    async draft({ title, body }) {
      return callOllama({
        host,
        model: draftModel,
        system: DRAFT_SYSTEM,
        prompt: buildDraftPrompt({ title, body }),
        jsonMode: false,
      });
    },
  };
}
