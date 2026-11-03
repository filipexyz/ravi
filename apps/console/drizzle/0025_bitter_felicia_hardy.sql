CREATE TYPE "public"."knowledge_chunk_status" AS ENUM('active', 'redacted', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."knowledge_document_status" AS ENUM('created', 'parsed', 'chunked', 'indexed', 'failed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."knowledge_index_status" AS ENUM('active', 'rebuilding', 'stale', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."knowledge_ingestion_job_status" AS ENUM('queued', 'running', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."knowledge_retrieval_run_status" AS ENUM('completed', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."knowledge_retrieval_strategy_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."knowledge_sensitivity" AS ENUM('standard', 'confidential', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_status" AS ENUM('active', 'disabled', 'revoked', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."knowledge_source_type" AS ENUM('manual_note', 'file_upload', 'artifact', 'meeting', 'mail_thread', 'calendar_event', 'github_repository', 'ravi_page', 'provider_resource', 'external_rag_collection');--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"source_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"permission_snapshot_id" uuid NOT NULL,
	"chunk_ordinal" integer NOT NULL,
	"chunk_key" text NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"token_count" integer,
	"char_start" integer,
	"char_end" integer,
	"status" "knowledge_chunk_status" DEFAULT 'active' NOT NULL,
	"location_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"retrieval_run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score" numeric(10, 6),
	"excerpt" text NOT NULL,
	"citation_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"source_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"title" text NOT NULL,
	"status" "knowledge_document_status" DEFAULT 'created' NOT NULL,
	"content_hash" text,
	"mime_type" text,
	"language" text,
	"parser_version" text,
	"size_bytes" bigint,
	"source_location_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_indexes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"backend" text NOT NULL,
	"isolation_tier" text DEFAULT 'standard' NOT NULL,
	"status" "knowledge_index_status" DEFAULT 'active' NOT NULL,
	"strategy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_rebuild_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"source_id" uuid NOT NULL,
	"document_id" uuid,
	"status" "knowledge_ingestion_job_status" DEFAULT 'queued' NOT NULL,
	"trigger_type" text DEFAULT 'manual' NOT NULL,
	"idempotency_key" text,
	"request_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"requested_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"requested_by_actor_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_permission_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"source_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"snapshot_hash" text NOT NULL,
	"policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captured_by_actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"captured_by_actor_id" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_retrieval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"strategy_id" uuid,
	"actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"actor_id" text,
	"status" "knowledge_retrieval_run_status" NOT NULL,
	"query_text" text NOT NULL,
	"query_hash" text,
	"requested_scope_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prefilter_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"postfilter_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"returned_chunk_count" integer DEFAULT 0 NOT NULL,
	"denied_reason" text,
	"duration_ms" integer,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_retrieval_strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"project_scope" text DEFAULT '*' NOT NULL,
	"index_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"status" "knowledge_retrieval_strategy_status" DEFAULT 'active' NOT NULL,
	"default_limit" integer DEFAULT 8 NOT NULL,
	"pipeline_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"owner_user_id" uuid,
	"source_type" "knowledge_source_type" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "knowledge_source_status" DEFAULT 'active' NOT NULL,
	"sensitivity" "knowledge_sensitivity" DEFAULT 'standard' NOT NULL,
	"source_ref_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_ref_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retention_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"created_by_actor_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_permission_snapshot_id_knowledge_permission_snapshots_id_fk" FOREIGN KEY ("permission_snapshot_id") REFERENCES "public"."knowledge_permission_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_retrieval_run_id_knowledge_retrieval_runs_id_fk" FOREIGN KEY ("retrieval_run_id") REFERENCES "public"."knowledge_retrieval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_citations" ADD CONSTRAINT "knowledge_citations_chunk_id_knowledge_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."knowledge_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_indexes" ADD CONSTRAINT "knowledge_indexes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_indexes" ADD CONSTRAINT "knowledge_indexes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_ingestion_jobs" ADD CONSTRAINT "knowledge_ingestion_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_ingestion_jobs" ADD CONSTRAINT "knowledge_ingestion_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_ingestion_jobs" ADD CONSTRAINT "knowledge_ingestion_jobs_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_ingestion_jobs" ADD CONSTRAINT "knowledge_ingestion_jobs_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_permission_snapshots" ADD CONSTRAINT "knowledge_permission_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_permission_snapshots" ADD CONSTRAINT "knowledge_permission_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_permission_snapshots" ADD CONSTRAINT "knowledge_permission_snapshots_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_permission_snapshots" ADD CONSTRAINT "knowledge_permission_snapshots_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD CONSTRAINT "knowledge_retrieval_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD CONSTRAINT "knowledge_retrieval_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_runs" ADD CONSTRAINT "knowledge_retrieval_runs_strategy_id_knowledge_retrieval_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."knowledge_retrieval_strategies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_strategies" ADD CONSTRAINT "knowledge_retrieval_strategies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_strategies" ADD CONSTRAINT "knowledge_retrieval_strategies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_retrieval_strategies" ADD CONSTRAINT "knowledge_retrieval_strategies_index_id_knowledge_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."knowledge_indexes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_document_ordinal_unique" ON "knowledge_chunks" USING btree ("document_id","chunk_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_source_key_unique" ON "knowledge_chunks" USING btree ("source_id","chunk_key");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_org_status_idx" ON "knowledge_chunks" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_project_status_idx" ON "knowledge_chunks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_source_idx" ON "knowledge_chunks" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_document_idx" ON "knowledge_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_permission_snapshot_idx" ON "knowledge_chunks" USING btree ("permission_snapshot_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_text_hash_idx" ON "knowledge_chunks" USING btree ("text_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_citations_run_rank_unique" ON "knowledge_citations" USING btree ("retrieval_run_id","rank");--> statement-breakpoint
CREATE INDEX "knowledge_citations_org_idx" ON "knowledge_citations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_citations_project_idx" ON "knowledge_citations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "knowledge_citations_run_idx" ON "knowledge_citations" USING btree ("retrieval_run_id");--> statement-breakpoint
CREATE INDEX "knowledge_citations_source_idx" ON "knowledge_citations" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "knowledge_citations_document_idx" ON "knowledge_citations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_citations_chunk_idx" ON "knowledge_citations" USING btree ("chunk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_source_version_unique" ON "knowledge_documents" USING btree ("source_id","version_number");--> statement-breakpoint
CREATE INDEX "knowledge_documents_org_status_idx" ON "knowledge_documents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_documents_project_status_idx" ON "knowledge_documents" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_documents_source_idx" ON "knowledge_documents" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "knowledge_documents_content_hash_idx" ON "knowledge_documents" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "knowledge_documents_updated_at_idx" ON "knowledge_documents" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_indexes_org_key_unique" ON "knowledge_indexes" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "knowledge_indexes_org_status_idx" ON "knowledge_indexes" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_indexes_project_idx" ON "knowledge_indexes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "knowledge_indexes_backend_idx" ON "knowledge_indexes" USING btree ("backend");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_ingestion_jobs_org_idempotency_unique" ON "knowledge_ingestion_jobs" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "knowledge_ingestion_jobs_org_status_idx" ON "knowledge_ingestion_jobs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_ingestion_jobs_project_status_idx" ON "knowledge_ingestion_jobs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_ingestion_jobs_source_idx" ON "knowledge_ingestion_jobs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "knowledge_ingestion_jobs_document_idx" ON "knowledge_ingestion_jobs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_ingestion_jobs_request_idx" ON "knowledge_ingestion_jobs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "knowledge_ingestion_jobs_updated_at_idx" ON "knowledge_ingestion_jobs" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "knowledge_permission_snapshots_org_idx" ON "knowledge_permission_snapshots" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_permission_snapshots_project_idx" ON "knowledge_permission_snapshots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "knowledge_permission_snapshots_source_idx" ON "knowledge_permission_snapshots" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "knowledge_permission_snapshots_document_idx" ON "knowledge_permission_snapshots" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "knowledge_permission_snapshots_hash_idx" ON "knowledge_permission_snapshots" USING btree ("snapshot_hash");--> statement-breakpoint
CREATE INDEX "knowledge_permission_snapshots_captured_at_idx" ON "knowledge_permission_snapshots" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_runs_org_created_at_idx" ON "knowledge_retrieval_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_runs_project_created_at_idx" ON "knowledge_retrieval_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_runs_strategy_idx" ON "knowledge_retrieval_runs" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_runs_actor_idx" ON "knowledge_retrieval_runs" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_runs_status_idx" ON "knowledge_retrieval_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_runs_query_hash_idx" ON "knowledge_retrieval_runs" USING btree ("query_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_retrieval_strategies_scope_key_unique" ON "knowledge_retrieval_strategies" USING btree ("organization_id","project_scope","key");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_strategies_org_status_idx" ON "knowledge_retrieval_strategies" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_strategies_project_idx" ON "knowledge_retrieval_strategies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "knowledge_retrieval_strategies_index_idx" ON "knowledge_retrieval_strategies" USING btree ("index_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_org_status_idx" ON "knowledge_sources" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_sources_project_status_idx" ON "knowledge_sources" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_sources_owner_idx" ON "knowledge_sources" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "knowledge_sources_type_idx" ON "knowledge_sources" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "knowledge_sources_sensitivity_idx" ON "knowledge_sources" USING btree ("sensitivity");--> statement-breakpoint
CREATE INDEX "knowledge_sources_updated_at_idx" ON "knowledge_sources" USING btree ("updated_at");
