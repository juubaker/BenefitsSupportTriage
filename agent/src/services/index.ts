/**
 * Composition helper: builds the real TriageServices from environment config.
 * This is the only place in the agent package that reaches for a driver, and
 * it is meant to be called from a composition root (the Express app, the MCP
 * server, or scripts/smoke-live.ts) — never from loop/harness code.
 *
 *   DATABASE_URL          postgres connection string
 *   OLLAMA_URL            default http://localhost:11434
 *   OLLAMA_EMBED_MODEL    default nomic-embed-text (768-dim, must match ingest)
 *   RETRIEVAL_MIN_SIM     default 0.45
 */

import { Pool } from "pg";
import { createOllamaEmbedder } from "./embeddings.js";
import { createPgTriageServices, type PgTriageServicesFactory, type Queryable } from "./pg-triage-services.js";

export * from "./embeddings.js";
export * from "./pg-triage-services.js";

export interface BuiltServices {
  services: PgTriageServicesFactory;
  pool: Pool;
  close(): Promise<void>;
}

export function buildTriageServices(env: NodeJS.ProcessEnv = process.env): BuiltServices {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to build the triage services");
  }
  const pool = new Pool({ connectionString });
  const services = createPgTriageServices({
    db: pool as unknown as Queryable,
    embed: createOllamaEmbedder({
      baseUrl: env.OLLAMA_URL,
      model: env.OLLAMA_EMBED_MODEL,
    }),
    minSimilarity: env.RETRIEVAL_MIN_SIM ? Number(env.RETRIEVAL_MIN_SIM) : undefined,
  });

  return { services, pool, close: () => pool.end() };
}
