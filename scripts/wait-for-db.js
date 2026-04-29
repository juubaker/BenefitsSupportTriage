// scripts/wait-for-db.js
// Polls the configured Postgres until it accepts a connection.
// Useful in `npm run db:setup` so migrations don't race the container.

import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgresql://triage:triage@localhost:5433/triage';
const TIMEOUT_MS = 30_000;
const INTERVAL_MS = 500;

async function tryConnect() {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    try {
      await client.end();
    } catch {
      // ignore
    }
    return false;
  }
}

async function main() {
  const start = Date.now();
  process.stdout.write('▸ Waiting for Postgres');
  while (Date.now() - start < TIMEOUT_MS) {
    if (await tryConnect()) {
      process.stdout.write(' ✓\n');
      return;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  process.stdout.write(' ✗\n');
  console.error(`✗ Postgres at ${url} did not accept connections within ${TIMEOUT_MS}ms`);
  console.error('  Try: docker compose up -d postgres');
  process.exit(1);
}

main();
