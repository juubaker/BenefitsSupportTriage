/**
 * One embedding client for the whole repo.
 *
 * There were three, with different capabilities and no shared config:
 *
 *   agent/src/services/embeddings.ts  dimension check, injectable fetch
 *   rag/lib/embeddings.ts             embedBatch, Voyage provider, EMBED_DIM
 *   server/rag/embed.js               neither
 *
 * They all talked to the same corpus, so a difference between any two of them
 * was a correctness bug waiting to happen rather than mere duplication — and
 * the one with the dimension check was not the one the ingest used.
 *
 * This lives in its own package rather than in any of the three because the
 * ingest pipeline is a leaf: nothing imports it and it imports nothing of
 * ours, so `npm run ingest` needs no build. Had it imported the agent instead,
 * ingest would have required the agent to be built first, which inverts the
 * dependency (the pipeline feeding the product would depend on the product)
 * and puts a build back on the first-run path.
 */

export {
  DEFAULT_DIMENSIONS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_VOYAGE_MODEL,
  readEmbedConfig,
  type EmbedConfig,
  type EmbedProvider,
} from "./config.js";

import {
  readEmbedConfig,
  type EmbedConfig,
} from "./config.js";

/** One text in, one vector out. The shape the agent injects as a port. */
export type Embedder = (text: string) => Promise<number[]>;

export interface EmbedClient {
  embed: Embedder;
  /** Several at once. Voyage batches natively; Ollama has no batch endpoint. */
  embedBatch: (texts: string[]) => Promise<number[][]>;
  config: EmbedConfig;
}

export interface CreateEmbedClientOptions {
  /** Overrides on top of the environment. */
  config?: Partial<EmbedConfig>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** pgvector literal form: "[0.1,0.2,...]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

function assertWidth(vec: number[], config: EmbedConfig, model: string): number[] {
  // Fail here rather than at query time. A vector of the wrong width does not
  // error in pgvector's `<=>` — it either refuses the comparison or, worse,
  // silently ranks against a corpus it cannot be compared with.
  if (vec.length !== config.dimensions) {
    throw new Error(
      `Embedding width ${vec.length} does not match corpus width ${config.dimensions} ` +
        `(model "${model}"). Re-ingest, or set EMBED_DIM and the schema's vector(...) to match.`,
    );
  }
  return vec;
}

export function createEmbedClient(options: CreateEmbedClientOptions = {}): EmbedClient {
  const config: EmbedConfig = { ...readEmbedConfig(), ...options.config };
  const doFetch = options.fetchImpl ?? fetch;
  const model = config.provider === "voyage" ? config.voyageModel : config.ollamaModel;

  async function embedOllama(text: string): Promise<number[]> {
    const res = await doFetch(`${config.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.ollamaModel, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) {
      throw new Error("Ollama embed returned no embedding array");
    }
    return json.embedding;
  }

  async function embedVoyageBatch(texts: string[]): Promise<number[][]> {
    if (!config.voyageApiKey) {
      throw new Error("EMBED_PROVIDER=voyage requires VOYAGE_API_KEY");
    }
    const res = await doFetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.voyageApiKey}`,
      },
      body: JSON.stringify({ input: texts, model: config.voyageModel }),
    });
    if (!res.ok) {
      throw new Error(`Voyage embed failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    if (!Array.isArray(json.data)) {
      throw new Error("Voyage embed returned no data array");
    }
    if (json.data.length !== texts.length) {
      throw new Error(
        `Voyage returned ${json.data.length} vectors for ${texts.length} texts`,
      );
    }
    return json.data.map((d) => d.embedding);
  }

  const embed: Embedder = async (text) => {
    const vec =
      config.provider === "voyage" ? (await embedVoyageBatch([text]))[0] : await embedOllama(text);
    return assertWidth(vec, config, model);
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    if (config.provider === "voyage") {
      const vectors = await embedVoyageBatch(texts);
      return vectors.map((v) => assertWidth(v, config, model));
    }
    // Sequential on purpose: ingest runs against one local Ollama, and firing
    // every chunk at it at once makes it slower, not faster.
    const out: number[][] = [];
    for (const text of texts) out.push(await embed(text));
    return out;
  };

  return { embed, embedBatch, config };
}

/**
 * Just the embed function, for callers that inject an `Embedder` port and do
 * not need batching — which is how the agent's retrieval services take it.
 */
export function createEmbedder(options: CreateEmbedClientOptions = {}): Embedder {
  return createEmbedClient(options).embed;
}
