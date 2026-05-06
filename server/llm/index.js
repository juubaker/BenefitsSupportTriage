// server/llm/index.js
// Provider registry. Resolves LLM provider config from env into concrete
// adapters. The registry is the only place that knows about all providers —
// the rest of the app sees a uniform LLMProvider interface.
//
// Per-route configuration is supported. The two routes (categorize, draft)
// can use *different* providers — e.g. cheap local Ollama for classify,
// high-quality Anthropic for drafts. Resolution order:
//
//   /api/categorize  → LLM_PROVIDER_TRIAGE  →  LLM_PROVIDER  →  'anthropic'
//   /api/draft       → LLM_PROVIDER_DRAFT   →  LLM_PROVIDER  →  'anthropic'
//
// Common configurations:
//
//   # everything on Anthropic (default, today's behavior)
//   LLM_PROVIDER=anthropic
//
//   # everything local
//   LLM_PROVIDER=ollama
//
//   # mixed: cheap classify, quality draft
//   LLM_PROVIDER_TRIAGE=ollama
//   LLM_PROVIDER_DRAFT=anthropic

import { createAnthropicProvider } from './anthropic.js';
import { createOllamaProvider } from './ollama.js';

const FACTORIES = {
  anthropic: createAnthropicProvider,
  ollama: createOllamaProvider,
};

export const SUPPORTED_PROVIDERS = Object.keys(FACTORIES);

function resolveName(name, env, fallback = 'anthropic') {
  return (name || env.LLM_PROVIDER || fallback).toLowerCase();
}

function buildProvider(name, env) {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new Error(
      `Unknown LLM provider "${name}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }
  return factory(env);
}

/**
 * Single-provider factory. Used by callers that want one provider for both
 * routes (the common case) or by tests. Resolution order:
 *   explicit name → LLM_PROVIDER env → 'anthropic'
 */
export function createProvider(name, env = process.env) {
  return buildProvider(resolveName(name, env), env);
}

/**
 * Per-route provider factory. Returns { triage, draft } where each is an
 * LLMProvider. Both default to LLM_PROVIDER (or 'anthropic'); each can be
 * overridden by LLM_PROVIDER_TRIAGE / LLM_PROVIDER_DRAFT.
 *
 * Adapter instances are reused when triage and draft resolve to the same
 * provider — saves a redundant fetch keep-alive pool and clarifies logs.
 */
export function createProviders(env = process.env) {
  const triageName = (env.LLM_PROVIDER_TRIAGE || env.LLM_PROVIDER || 'anthropic').toLowerCase();
  const draftName = (env.LLM_PROVIDER_DRAFT || env.LLM_PROVIDER || 'anthropic').toLowerCase();

  const triage = buildProvider(triageName, env);
  // Reuse the same instance when both routes use the same provider.
  const draft = draftName === triageName ? triage : buildProvider(draftName, env);

  return { triage, draft };
}

export { extractJson } from './shared.js';
