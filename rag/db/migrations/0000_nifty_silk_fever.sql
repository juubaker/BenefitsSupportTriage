CREATE TABLE "policy_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_title" text NOT NULL,
	"section" text,
	"chunk_text" text NOT NULL,
	"source_url" text,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolved_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_text" text NOT NULL,
	"category" text NOT NULL,
	"approved_response" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retrieval_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_text" text NOT NULL,
	"retrieved_policy_ids" text NOT NULL,
	"retrieved_ticket_ids" text NOT NULL,
	"cited_policy_ids" text NOT NULL,
	"top_similarity" real,
	"abstained" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "policy_chunks_embedding_idx" ON "policy_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "resolved_tickets_embedding_idx" ON "resolved_tickets" USING hnsw ("embedding" vector_cosine_ops);