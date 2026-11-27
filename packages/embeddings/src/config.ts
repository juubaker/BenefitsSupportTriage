/**
 * Embedding configuration, in one place for every consumer.
 *
 * Previously this lived only in rag/lib/config.ts, which the agent and the v1
 * server could not reach — so each hard-coded its own model name and default
 * URL, and nothing tied them to the dimension the corpus was actually built
 * with. A vector embedded at one width cannot be compared with one at another,
 * so a drift between two of the three copies would not fail loudly: it would
 * return wrong neighbours.
 *
 * Changing the model means changing three things together: DEFAULT_DIMENSIONS
 * here, the vector(...) width in the Drizzle schema, and a re-ingest so every
 * stored row is re-embedded.
 *
 *   nomic-embed-text (Ollama, default) -> 768
 *   mxbai-embed-large (Ollama)         -> 1024
 *   voyage-3 (Voyage AI)               -> 1024
 *   text-embedding-3-small (OpenAI)    -> 1536
 */

export type EmbedProvider = "ollama" | "voyage";

export const DEFAULT_DIMENSIONS = 768;
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
export const DEFAULT_VOYAGE_MODEL = "voyage-3";

export interface EmbedConfig {
  provider: EmbedProvider;
  dimensions: number;
  ollamaUrl: string;
  ollamaModel: string;
  voyageModel: string;
  voyageApiKey?: string;
}

/**
 * Reads the environment, falling back to the defaults above.
 *
 * `EMBED_DIM` is honoured for compatibility with the older rag config, which
 * is the name the corpus was ingested under.
 */
export function readEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig {
  const provider = (env.EMBED_PROVIDER ?? "ollama") as EmbedProvider;
  if (provider !== "ollama" && provider !== "voyage") {
    throw new Error(
      `EMBED_PROVIDER must be "ollama" or "voyage", got ${JSON.stringify(env.EMBED_PROVIDER)}`,
    );
  }
  const dimensions = env.EMBED_DIM ? Number(env.EMBED_DIM) : DEFAULT_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`EMBED_DIM must be a positive integer, got ${JSON.stringify(env.EMBED_DIM)}`);
  }
  return {
    provider,
    dimensions,
    ollamaUrl: env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    ollamaModel: env.OLLAMA_EMBED_MODEL ?? DEFAULT_OLLAMA_MODEL,
    voyageModel: env.VOYAGE_EMBED_MODEL ?? DEFAULT_VOYAGE_MODEL,
    voyageApiKey: env.VOYAGE_API_KEY,
  };
}
