/**
 * Composition root for the agent: turns environment config into a harness the
 * HTTP layer can call. This is the only place that constructs concrete
 * adapters — loop, budgeter and registry code stays on the ports.
 *
 * The tool registry is bound per ticket (the terminal tools need to know which
 * ticket they are finishing, and the tool schemas don't carry it), so this
 * returns a factory rather than a single harness. Harness construction is
 * cheap: it is a deps object plus a registry, no connections of its own.
 *
 *   DATABASE_URL            required
 *   OLLAMA_URL / _MODEL     local provider and embeddings
 *   ANTHROPIC_API_KEY       enables the anthropic provider
 *   AGENT_DEFAULT_PROVIDER  anthropic | ollama
 *   AGENT_TRACING           "true" to export OTLP spans
 */

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { AgentHarness } from "./harness.js";
import { DrizzleRunStore } from "./store.js";
import { buildProviders } from "./providers/index.js";
import { AgentTracing, initTracing } from "./tracing.js";
import { buildRegistry, SYSTEM_PROMPT } from "./tools.js";
import { createOllamaEmbedder } from "./services/embeddings.js";
import { createPgTriageServices, type Queryable } from "./services/pg-triage-services.js";

export interface AgentRuntime {
  /** A harness bound to one ticket. Build one per request. */
  harnessFor(ticketId: string): AgentHarness;
  /** Provider names actually configured, for /api/health. */
  providerNames: string[];
  defaultProvider: string;
  close(): Promise<void>;
}

export function createAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntime {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run the agent");
  }

  const pool = new Pool({ connectionString });
  const store = new DrizzleRunStore(drizzle(pool));
  const { providers, defaultProvider } = buildProviders(env);

  const services = createPgTriageServices({
    db: pool as unknown as Queryable,
    embed: createOllamaEmbedder({ baseUrl: env.OLLAMA_URL, model: env.OLLAMA_EMBED_MODEL }),
    minSimilarity: env.RETRIEVAL_MIN_SIM ? Number(env.RETRIEVAL_MIN_SIM) : undefined,
  });

  let tracing: AgentTracing | undefined;
  let shutdownTracing: (() => Promise<void>) | undefined;
  if (env.AGENT_TRACING === "true") {
    shutdownTracing = initTracing();
    tracing = new AgentTracing();
  }

  return {
    providerNames: Object.keys(providers),
    defaultProvider,
    harnessFor(ticketId: string) {
      return new AgentHarness({
        providers,
        defaultProvider: defaultProvider as never,
        registry: buildRegistry(services.forTicket({ ticketId })),
        store,
        systemPrompt: SYSTEM_PROMPT,
        tracing,
      });
    },
    async close() {
      await shutdownTracing?.();
      await pool.end();
    },
  };
}
