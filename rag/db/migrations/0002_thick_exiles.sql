-- Stable, model-visible ids for the two corpora.
--
-- Hand-edited after `drizzle-kit generate` to add IF NOT EXISTS, because the
-- database and the migrations have drifted: policy_chunks.chunk_key exists in
-- the running database but appears in no migration, so it was added with
-- db:push or by hand. Generated as-is, statement one fails with
-- `column "chunk_key" of relation "policy_chunks" already exists` and the
-- whole migration rolls back — which is exactly what happened.
--
-- The guards make this safe on a database that has chunk_key and on a fresh
-- one that does not. Worth knowing more generally: the snapshots are not a
-- faithful record of this schema's history, so `generate` will keep proposing
-- columns that already exist until a snapshot is reconciled with reality.
ALTER TABLE "policy_chunks" ADD COLUMN IF NOT EXISTS "chunk_key" text;--> statement-breakpoint

-- Why ticket_key exists: citations were "R-<serial id>", and the ingest
-- deleted every row before re-inserting, so the sequence advanced each run.
-- The same ticket was R-48, then R-117, then R-135. The row count never
-- changed, which is why it went unnoticed, but every R- id already stored in
-- triage_results now points at a different ticket or at nothing.
ALTER TABLE "resolved_tickets" ADD COLUMN IF NOT EXISTS "ticket_key" text;--> statement-breakpoint

-- Unique so the ingest can upsert on it, which keeps ids stable too.
-- Postgres treats NULLs as distinct, so rows ingested before this do not
-- collide with one another.
CREATE UNIQUE INDEX IF NOT EXISTS "resolved_tickets_ticket_key_idx" ON "resolved_tickets" USING btree ("ticket_key");
