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

const app = createApp({ providers });

app.listen(PORT, () => {
  console.log(`\n▸ Triage API listening on http://localhost:${PORT}`);
  console.log(`  triage  →  ${providers.triage.name}: ${providers.triage.triageModel}`);
  console.log(`  draft   →  ${providers.draft.name}: ${providers.draft.draftModel}`);
  if (providers.triage === providers.draft) {
    console.log(`  (single adapter shared by both routes)`);
  }
  console.log(`  health  →  http://localhost:${PORT}/api/health\n`);
});
