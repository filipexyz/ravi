-- Idempotent: preview builds may apply this to a shared database before main; it may run twice.
DO $$ BEGIN
  CREATE TYPE "public"."knowledge_trust_tier" AS ENUM('approved', 'published', 'said', 'inferred');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."knowledge_proposal_kind" AS ENUM('note', 'gap', 'correction', 'transcript');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."knowledge_proposal_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "origin_key" text;
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "trust_tier" "knowledge_trust_tier" DEFAULT 'said' NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "retain_until" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_sources_org_origin_key_unique" ON "knowledge_sources" USING btree ("organization_id","origin_key") WHERE "origin_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_retain_until_idx" ON "knowledge_sources" USING btree ("retain_until");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_documents_source_status_idx" ON "knowledge_documents" USING btree ("source_id","status");
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "stable_key" text;
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "trust_tier" "knowledge_trust_tier" DEFAULT 'said' NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "search_vector" tsvector;
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "search_vector_stem" tsvector;
--> statement-breakpoint
DROP INDEX IF EXISTS "knowledge_chunks_source_key_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_chunks_document_key_unique" ON "knowledge_chunks" USING btree ("document_id","chunk_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_source_stable_key_idx" ON "knowledge_chunks" USING btree ("source_id","stable_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_search_idx" ON "knowledge_chunks" USING gin ("search_vector");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_search_stem_idx" ON "knowledge_chunks" USING gin ("search_vector_stem");
--> statement-breakpoint
ALTER TABLE "knowledge_ingestion_jobs" ADD COLUMN IF NOT EXISTS "max_attempts" integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_ingestion_jobs" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "knowledge_ingestion_jobs" ADD COLUMN IF NOT EXISTS "locked_by" text;
--> statement-breakpoint
ALTER TABLE "knowledge_ingestion_jobs" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_ingestion_jobs_due_idx" ON "knowledge_ingestion_jobs" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_ingestion_jobs_locked_until_idx" ON "knowledge_ingestion_jobs" USING btree ("locked_until");
--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ALTER COLUMN "query_text" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD COLUMN IF NOT EXISTS "audience" text DEFAULT 'operator' NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD COLUMN IF NOT EXISTS "caller_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD COLUMN IF NOT EXISTS "denied_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD COLUMN IF NOT EXISTS "normalized_query" text;
--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD COLUMN IF NOT EXISTS "cost_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD COLUMN IF NOT EXISTS "local_installation_id" uuid;
--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD COLUMN IF NOT EXISTS "turn_key" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_retrieval_runs" ADD CONSTRAINT "knowledge_runs_installation_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_retrieval_runs_installation_turn_idx" ON "knowledge_retrieval_runs" USING btree ("local_installation_id","turn_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_retrieval_runs_created_at_idx" ON "knowledge_retrieval_runs" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ALTER COLUMN "source_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ALTER COLUMN "document_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ALTER COLUMN "chunk_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ALTER COLUMN "excerpt" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD COLUMN IF NOT EXISTS "text_hash" text;
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD COLUMN IF NOT EXISTS "document_version" integer;
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD COLUMN IF NOT EXISTS "char_start" integer;
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD COLUMN IF NOT EXISTS "char_end" integer;
--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD COLUMN IF NOT EXISTS "trust_tier" "knowledge_trust_tier";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_citations" DROP CONSTRAINT IF EXISTS "knowledge_citations_source_id_knowledge_sources_id_fk";
  ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE set null ON UPDATE no action;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_citations" DROP CONSTRAINT IF EXISTS "knowledge_citations_document_id_knowledge_documents_id_fk";
  ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_citations" DROP CONSTRAINT IF EXISTS "knowledge_citations_chunk_id_knowledge_chunks_id_fk";
  ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_chunk_id_knowledge_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."knowledge_chunks"("id") ON DELETE set null ON UPDATE no action;
END $$;
--> statement-breakpoint
UPDATE "knowledge_citations" SET "excerpt" = NULL WHERE "excerpt" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" "knowledge_proposal_kind" NOT NULL,
	"status" "knowledge_proposal_status" DEFAULT 'pending' NOT NULL,
	"title" text,
	"body" text,
	"body_hash" text,
	"answer_text" text,
	"faq_question" text,
	"evidence_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supersedes_ref" text,
	"requested_audience_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed_by_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"local_installation_id" uuid,
	"dedupe_key" text,
	"idempotency_key" text,
	"waiting_count" integer DEFAULT 1 NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"result_source_id" uuid,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ALTER COLUMN "body" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD COLUMN IF NOT EXISTS "body_hash" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_installation_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_decided_by_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_result_source_fk" FOREIGN KEY ("result_source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_proposals_org_status_created_idx" ON "knowledge_proposals" USING btree ("organization_id","status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_proposals_project_status_idx" ON "knowledge_proposals" USING btree ("project_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_proposals_installation_idx" ON "knowledge_proposals" USING btree ("local_installation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_proposals_expires_at_idx" ON "knowledge_proposals" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_proposals_pending_dedupe_unique" ON "knowledge_proposals" USING btree ("organization_id","local_installation_id","dedupe_key") WHERE "dedupe_key" IS NOT NULL AND "status" = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_proposals_idempotency_unique" ON "knowledge_proposals" USING btree ("organization_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
