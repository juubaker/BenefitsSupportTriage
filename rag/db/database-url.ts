/**
 * Where the ingest pipeline's DATABASE_URL comes from, and saying so.
 *
 * This read `process.env.DATABASE_URL` with no dotenv loading and no default,
 * so `npm run ingest` from a fresh shell got `ECONNREFUSED ... :5432` — pg's
 * default port — while Postgres sat on 5433 and the URL sat unread in the
 * repo's .env. The error named a port nothing was ever configured to use,
 * which is the worst kind: it points away from the problem.
 *
 * The root .env is the one the server reads (server/index.js does
 * `import 'dotenv/config'`, resolving against the repo root). Loading the same
 * file here keeps one source of truth, and the default matches
 * docker-compose.yml so a clone works before anyone writes a .env at all.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Mirrors docker-compose.yml: host port 5433, not pg's default 5432. */
export const COMPOSE_DATABASE_URL = "postgres://triage:triage@localhost:5433/triage";

/**
 * Walk up from this file to the first directory holding a .env, stopping at
 * the filesystem root. Works whether the script is run from the repo root or
 * from rag/, which is the difference that caused the original bug.
 */
function loadEnvFile(): string | undefined {
  // import.meta.dirname is undefined wherever this module is loaded as
  // CommonJS, which is how drizzle-kit loads drizzle.config.ts: it transpiles
  // the config rather than importing it as ESM. Reaching resolve() with
  // undefined threw `The "paths[0]" argument must be of type string`, so the
  // config failed for a reason that had nothing to do with the database.
  // cwd is the right fallback: every script here runs from the package or the
  // repo root, and the walk upward covers both.
  const here = typeof import.meta.dirname === "string" ? import.meta.dirname : process.cwd();
  let dir = resolve(here, "..");
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        return candidate;
      } catch {
        // A malformed .env should not stop ingest when the environment is
        // already set; resolveDatabaseUrl below reports what it ended up with.
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export type UrlSource = "environment" | "env file" | "default";

export function resolveDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  loadEnv: () => string | undefined = loadEnvFile,
): { url: string; source: UrlSource } {
  // An explicit environment variable wins: CI and one-off overrides set it.
  if (env.DATABASE_URL) return { url: env.DATABASE_URL, source: "environment" };
  // loadEnv mutates process.env, so the file's value shows up there.
  if (loadEnv() && process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, source: "env file" };
  }
  return { url: COMPOSE_DATABASE_URL, source: "default" };
}
