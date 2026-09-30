/**
 * Agent server entry point — assembles the components into a running service.
 *
 * Per-run services: createPgTriageServices returns a FACTORY; services are bound
 * per ticket via forTicket(ctx), so the registry is built per run. The harness
 * takes registryFor and calls it once it has the runId (see harness EDIT 1-3).
 */
import express from "express";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import { createPgTriageServices } from "./services/pg-triage-services.js";
import { createOllamaEmbedder } from "./services/embeddings.js";
import { buildRegistry, SYSTEM_PROMPT } from "./tools.js";
import { buildProviders } from "./providers/index.js";
import { AgentHarness } from "./harness.js";
import { DrizzleRunStore } from "./store.js";
import { triageRouter } from "./routes/triage.js";
import { runsRouter } from "./routes/runs.js";

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// Ollama embedder (nomic-embed-text by default). Option keys per embeddings.ts —
// adjust if createOllamaEmbedder expects different field names.
const embed = createOllamaEmbedder({
  model: process.env.EMBED_MODEL ?? "nomic-embed-text",
  baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
});

// Factory: bind services (and thus the registry) per ticket.
const servicesFactory = createPgTriageServices({ db: pool, embed });

const { providers, defaultProvider } = buildProviders();
const store = new DrizzleRunStore(db);

const harness = new AgentHarness({
  providers,
  defaultProvider,
  store,
  systemPrompt: SYSTEM_PROMPT,
  registryFor: (ctx) => buildRegistry(servicesFactory.forTicket(ctx)),
});

const app = express();
app.use(express.json());
app.use(triageRouter(harness));
app.use(runsRouter(db));

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`agent server listening on :${port}`);
});
