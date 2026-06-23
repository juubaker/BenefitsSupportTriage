-- Run this ONCE against your database before generating/applying Drizzle
-- migrations. The CREATE EXTENSION must exist before any vector column is
-- created. drizzle-kit will create the tables + HNSW indexes for you.
--
--   psql "$DATABASE_URL" -f db/0000_enable_pgvector.sql
--
-- Requires the pgvector extension to be installed on the Postgres server.
-- (Postgres.app, Homebrew `pgvector`, or `CREATE EXTENSION` on a managed
-- instance that has it available, e.g. Supabase / RDS with the extension on.)

CREATE EXTENSION IF NOT EXISTS vector;
