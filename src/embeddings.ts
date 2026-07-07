/**
 * Thin wrapper around your existing Ollama nomic-embed-text embedding call.
 * If you already have this in `rag/embed.ts`, just re-export it:
 *
 *   export { embed } from "../../rag/embed.js";
 *
 * Standalone fallback below hits a local Ollama instance directly.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });

  if (!res.ok) {
    throw new Error(
      `Ollama embedding request failed: ${res.status} ${res.statusText}`
    );
  }

  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}
