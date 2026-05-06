// server/llm/types.js
//
// LLMProvider interface. Every adapter implements these two methods so the
// route layer never knows or cares which model is behind them.
//
// Each adapter returns the raw text response. Schema parsing (extracting
// JSON from the categorize call) lives in shared.js so adapters stay thin.
//
// Each adapter also exposes a `name` and the resolved `model` IDs it will
// use, so they can be persisted to the categorizations.model column for
// audit and cache invalidation.
//
// @typedef {Object} LLMProvider
// @property {string} name                 - "anthropic" | "ollama" | ...
// @property {string} triageModel          - identifier persisted to db
// @property {string} draftModel           - identifier persisted to db
// @property {(input: ClassifyInput) => Promise<string>} classify
// @property {(input: DraftInput) => Promise<string>} draft
//
// @typedef {Object} ClassifyInput
// @property {string} title
// @property {string} body
// @property {string[]} categories         - allowed labels
//
// @typedef {Object} DraftInput
// @property {string} title
// @property {string} body

export const PROVIDERS = ['anthropic', 'ollama'];
