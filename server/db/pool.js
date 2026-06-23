// server/db/pool.js
//
// ONLY ADD THIS IF YOUR REPOS DON'T ALREADY SHARE A POOL/CLIENT.
// If posts.js / drafts.js already import a pool or a Drizzle `db` from
// somewhere, import THAT in rag.js instead and delete this file — you don't
// want two pools against the same database.

import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
