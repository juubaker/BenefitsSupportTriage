import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",          // was ./rag/db/schema.ts
  out: "./db/migrations",            // was ./rag/db/migrations
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  migrations: {
    table: "drizzle_migrations_rag", // separate journal from your main app
  },
});
