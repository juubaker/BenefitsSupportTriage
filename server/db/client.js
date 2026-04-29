// server/db/client.js
// Lazily-created Drizzle client backed by node-postgres pool.

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

let _pool = null;
let _db = null;

function getPool() {
  if (_pool) return _pool;
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://triage:triage@localhost:5433/triage';
  _pool = new pg.Pool({
    connectionString,
    // Keep connections lean for a small app; tune for prod.
    max: 10,
    idleTimeoutMillis: 30_000,
    // Add a sensible connection timeout so failures fail fast instead of
    // hanging indefinitely on an unreachable host.
    connectionTimeoutMillis: 5_000,
  });
  _pool.on('error', (err) => {
    console.error('[db] unexpected pool error', err);
  });
  return _pool;
}

export function getDb() {
  if (_db) return _db;
  _db = drizzle(getPool(), { schema });
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

export { schema };
