import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./db/database-url.js";

/**
 * drizzle-kit does not load .env, and this read `process.env.DATABASE_URL!`
 * — the non-null assertion turning a missing value into `undefined` at
 * runtime, so `npm run db:migrate --workspace rag` from a shell without the
 * variable exported failed with "Please provide required params for Postgres
 * driver: [x] url: undefined" while the URL sat in the repo's .env.
 *
 * Same resolver the ingest uses, so the two cannot disagree about which
 * database they are pointed at — which would be worse than either failing.
 */
const { url } = resolveDatabaseUrl();

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  migrations: {
    table: "drizzle_migrations_rag", // separate journal from the main app's
  },
});
