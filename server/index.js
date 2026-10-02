// server/index.js
// Entry point. Loads env, builds providers, builds app, listens.

import 'dotenv/config';
import { createApp } from './app.js';
import { createProviders, SUPPORTED_PROVIDERS } from './llm/index.js';

const PORT = process.env.PORT || 3001;

let providers;
try {
  providers = createProviders();
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  console.error(`  Set LLM_PROVIDER (or LLM_PROVIDER_TRIAGE / LLM_PROVIDER_DRAFT) to one of:`);
  console.error(`  ${SUPPORTED_PROVIDERS.join(', ')}\n`);
  process.exit(1);
}

const usesAnthropic =
  providers.triage.name === 'anthropic' || providers.draft.name === 'anthropic';
if (usesAnthropic && !process.env.ANTHROPIC_API_KEY) {
  console.warn('\n⚠  ANTHROPIC_API_KEY is not set but an Anthropic provider is configured.');
  console.warn('   Set LLM_PROVIDER=ollama for local-only mode, or fill in .env\n');
}

// v2 agent: mounted when its build is present and a database is configured.
// A missing build or connection is not fatal — the v1 API still serves, and
// POST /api/triage answers 503 explaining how to enable it.
let agentRouter = null;
let agentRuntime = null;
if (process.env.AGENT_ENABLED !== 'false') {
  try {
    const { createAgentRuntime } = await import('../agent/dist/src/create-harness.js');
    const { triageRouter } = await import('../agent/dist/src/routes/triage.js');
    agentRuntime = createAgentRuntime();
    agentRouter = triageRouter((ticketId) => agentRuntime.harnessFor(ticketId));
  } catch (e) {
    const hint = e.code === 'ERR_MODULE_NOT_FOUND'
      ? 'run `npm run agent:build` to enable POST /api/triage'
      : e.message;
    console.warn(`\n⚠  Agent not mounted: ${hint}\n`);
  }
}

const app = createApp({ providers, agentRouter });

app.listen(PORT, () => {
  console.log(`\n▸ Triage API listening on http://localhost:${PORT}`);
  console.log(`  triage  →  ${providers.triage.name}: ${providers.triage.triageModel}`);
  console.log(`  draft   →  ${providers.draft.name}: ${providers.draft.draftModel}`);
  if (providers.triage === providers.draft) {
    console.log(`  (single adapter shared by both routes)`);
  }
  console.log(
    agentRuntime
      ? `  agent   →  ${agentRuntime.defaultProvider} (POST /api/triage)`
      : `  agent   →  not mounted`,
  );
  console.log(`  health  →  http://localhost:${PORT}/api/health\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    agentRuntime?.close().finally(() => process.exit(0));
    if (!agentRuntime) process.exit(0);
  });
}
