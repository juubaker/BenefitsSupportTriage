/**
 * Central config for the RAG layer.
 *
 * EMBED_DIM MUST match the embedding model you use. If you switch models you
 * must (a) change this number, (b) change the vector(...) dimension in the
 * Drizzle schema, and (c) re-run ingest so every row is re-embedded. Vectors
 * of different dimensions cannot be compared.
 *
 *   nomic-embed-text (Ollama, default) -> 768
 *   mxbai-embed-large (Ollama)         -> 1024
 *   voyage-3 (Voyage AI)               -> 1024
 *   text-embedding-3-small (OpenAI)    -> 1536
 */
export const EMBED_DIM = 768;

// "ollama" (local, free, offline) or "voyage" (hosted, higher quality).
export const EMBED_PROVIDER = (process.env.EMBED_PROVIDER ?? "ollama") as
  | "ollama"
  | "voyage";

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const OLLAMA_EMBED_MODEL =
  process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

export const VOYAGE_EMBED_MODEL =
  process.env.VOYAGE_EMBED_MODEL ?? "voyage-3";

// Drafting model (Anthropic).
export const DRAFT_MODEL = process.env.DRAFT_MODEL ?? "claude-sonnet-4-6";

// Retrieval knobs.
export const PRECEDENT_K = Number(process.env.PRECEDENT_K ?? 3); // similar past tickets
export const POLICY_K = Number(process.env.POLICY_K ?? 5); // policy passages
export const MIN_SIMILARITY = Number(process.env.MIN_SIMILARITY ?? 0.45); // 0..1 cosine
