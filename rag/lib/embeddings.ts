import {
  EMBED_PROVIDER,
  EMBED_DIM,
  OLLAMA_URL,
  OLLAMA_EMBED_MODEL,
  VOYAGE_EMBED_MODEL,
} from "./config";

/**
 * Returns a single embedding vector for a piece of text.
 *
 * Default backend is local Ollama (free, offline, no key) so the whole demo
 * runs self-contained. Set EMBED_PROVIDER=voyage for higher-quality hosted
 * embeddings — remember to bump EMBED_DIM + the schema dimension to match.
 */
export async function embed(text: string): Promise<number[]> {
  const vec =
    EMBED_PROVIDER === "voyage"
      ? await embedVoyage(text)
      : await embedOllama(text);

  if (vec.length !== EMBED_DIM) {
    throw new Error(
      `Embedding dimension mismatch: model returned ${vec.length}, ` +
        `config EMBED_DIM is ${EMBED_DIM}. Update config + schema to match.`
    );
  }
  return vec;
}

/** Embed many texts. Ollama has no batch endpoint here, so we map; Voyage
 *  batches natively. Both are fine for an ingest job. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (EMBED_PROVIDER === "voyage") return embedVoyageBatch(texts);
  const out: number[][] = [];
  for (const t of texts) out.push(await embedOllama(t));
  return out;
}

async function embedOllama(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { embedding: number[] };
  return json.embedding;
}

async function embedVoyage(text: string): Promise<number[]> {
  const [v] = await embedVoyageBatch([text]);
  return v;
}

async function embedVoyageBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY ?? ""}`,
    },
    body: JSON.stringify({ input: texts, model: VOYAGE_EMBED_MODEL }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embed failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}
