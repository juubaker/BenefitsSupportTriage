// server/index.js
// Thin entry point: load env, build the app, listen.

import 'dotenv/config';
import { createApp } from './app.js';

const PORT = process.env.PORT || 3001;
const TRIAGE = process.env.ANTHROPIC_MODEL_TRIAGE || 'claude-haiku-4-5-20251001';
const DRAFT = process.env.ANTHROPIC_MODEL_DRAFT || 'claude-sonnet-4-6';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('\n⚠  ANTHROPIC_API_KEY is not set.');
  console.warn('   Copy .env.example to .env and fill it in before making API calls.\n');
}

const app = createApp();

app.listen(PORT, () => {
  console.log(`\n▸ Triage API listening on http://localhost:${PORT}`);
  console.log(`  triage model: ${TRIAGE}`);
  console.log(`  draft model:  ${DRAFT}`);
  console.log(`  health:       http://localhost:${PORT}/api/health\n`);
});
