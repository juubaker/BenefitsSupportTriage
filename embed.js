// server/rag/embed.js
//
// Query-time embedding. MUST match the model ingest used (nomic-embed-text,
// 768-dim) or the vectors won't be comparable. No new dependency — fetch to
// the local Ollama server.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

export async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  return json.embedding; // number[]
}

// pgvector wants a literal like "[0.1,0.2,...]"
export function toVectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}
