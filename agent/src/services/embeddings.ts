/**
 * Query-time embedding for the retrieval tools.
 *
 * MUST use the same model the ingest pipeline used (nomic-embed-text, 768-dim,
 * see rag/lib/config.ts) or the vectors are not comparable. This is the single
 * embedder for the agent package; server/rag/embed.js, rag/lib/embeddings.ts
 * and src/embeddings.ts are the older copies and should be retired as their
 * callers move over.
 */

export type Embedder = (text: string) => Promise<number[]>;

export interface OllamaEmbedderOptions {
  baseUrl?: string;
  model?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Expected vector width. Mismatches fail fast rather than at query time. */
  dimensions?: number;
}

export function createOllamaEmbedder(opts: OllamaEmbedderOptions = {}): Embedder {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
  const model = opts.model ?? process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  const doFetch = opts.fetchImpl ?? fetch;
  const dimensions = opts.dimensions ?? 768;

  return async function embed(text: string): Promise<number[]> {
    const res = await doFetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) {
      throw new Error("Ollama embed returned no embedding array");
    }
    if (json.embedding.length !== dimensions) {
      throw new Error(
        `Embedding width ${json.embedding.length} does not match corpus width ${dimensions} ` +
          `(model "${model}"). Re-ingest or change OLLAMA_EMBED_MODEL.`,
      );
    }
    return json.embedding;
  };
}

/** pgvector literal form: "[0.1,0.2,...]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
