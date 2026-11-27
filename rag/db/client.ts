/**
 * Postgres client for the ingest pipeline.
 *
 * The URL resolution lives in ./database-url so it can be tested without
 * opening a pool; see that file for why it exists.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { COMPOSE_DATABASE_URL, resolveDatabaseUrl } from "./database-url";

const { url, source } = resolveDatabaseUrl();
if (source !== "environment") {
  // Said out loud, because connecting somewhere the caller did not name is
  // exactly the situation where silence costs an hour.
  // eslint-disable-next-line no-console
  console.error(`[rag] DATABASE_URL from ${source}: ${url.replace(/:[^:@/]*@/, ":***@")}`);
}

const pool = new Pool({ connectionString: url });

export const db = drizzle(pool, { schema });
export { schema, COMPOSE_DATABASE_URL, resolveDatabaseUrl };
