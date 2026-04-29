CREATE TYPE "public"."post_status" AS ENUM('open', 'answered');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categorizations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "categorizations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"post_id" varchar(32) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"category" varchar(64) NOT NULL,
	"confidence" real NOT NULL,
	"reasoning" text,
	"model" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drafts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drafts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"post_id" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"model" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "posts" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "post_status" DEFAULT 'open' NOT NULL,
	"source" varchar(64) NOT NULL,
	"author" varchar(256) NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"answer" text,
	"answered_by" varchar(128),
	"seed_category_id" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "categorizations" ADD CONSTRAINT "categorizations_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drafts" ADD CONSTRAINT "drafts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categorizations_post_id_idx" ON "categorizations" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "categorizations_hash_model_idx" ON "categorizations" USING btree ("content_hash","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drafts_post_id_idx" ON "drafts" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_status_idx" ON "posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "posts_posted_at_idx" ON "posts" USING btree ("posted_at");