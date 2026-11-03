CREATE TABLE "cloud_sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"local_installation_id" uuid NOT NULL,
	"project_id" uuid,
	"project_scope" text DEFAULT '*' NOT NULL,
	"domain" text NOT NULL,
	"last_delivered_sequence" bigint DEFAULT 0 NOT NULL,
	"last_acked_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_sync_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"origin_installation_id" uuid,
	"source_kind" text DEFAULT 'local_installation' NOT NULL,
	"source_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"domain" text NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"entity_revision" integer,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_trace_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"trace_session_id" uuid NOT NULL,
	"turn_id" uuid,
	"kind" text NOT NULL,
	"r2_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sensitivity" text DEFAULT 'content' NOT NULL,
	"encryption_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retention_class" text DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_trace_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_session_id" uuid NOT NULL,
	"turn_id" uuid,
	"organization_id" uuid NOT NULL,
	"source_event_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_type" text NOT NULL,
	"event_group" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"status" text,
	"safe_preview" text,
	"safe_payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blob_ref" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_trace_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"local_installation_id" uuid,
	"external_trace_id" text NOT NULL,
	"session_key" text NOT NULL,
	"session_name" text,
	"run_id" text,
	"agent_ref" text,
	"managed_runtime_session_id" text,
	"placement" text DEFAULT 'local' NOT NULL,
	"runtime_provider" text NOT NULL,
	"runtime_model" text,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_trace_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_session_id" uuid NOT NULL,
	"turn_id" uuid,
	"organization_id" uuid NOT NULL,
	"tool_call_id" text,
	"tool_name" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"input_preview" text,
	"output_preview" text,
	"input_blob_ref" text,
	"output_blob_ref" text,
	"approval_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_trace_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_session_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"source_turn_id" text,
	"sequence" bigint NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"prompt_sha256" text,
	"user_prompt_sha256" text,
	"system_prompt_sha256" text,
	"request_blob_sha256" text,
	"request_blob_ref" text,
	"response_blob_ref" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 8),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_sync_cursors" ADD CONSTRAINT "cloud_sync_cursors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_sync_cursors" ADD CONSTRAINT "cloud_sync_cursors_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_sync_cursors" ADD CONSTRAINT "cloud_sync_cursors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_sync_events" ADD CONSTRAINT "cloud_sync_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_sync_events" ADD CONSTRAINT "cloud_sync_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_sync_events" ADD CONSTRAINT "cloud_sync_events_origin_installation_id_local_installations_id_fk" FOREIGN KEY ("origin_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_blobs" ADD CONSTRAINT "runtime_trace_blobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_blobs" ADD CONSTRAINT "runtime_trace_blobs_trace_session_id_runtime_trace_sessions_id_fk" FOREIGN KEY ("trace_session_id") REFERENCES "public"."runtime_trace_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_blobs" ADD CONSTRAINT "runtime_trace_blobs_turn_id_runtime_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."runtime_trace_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_events" ADD CONSTRAINT "runtime_trace_events_trace_session_id_runtime_trace_sessions_id_fk" FOREIGN KEY ("trace_session_id") REFERENCES "public"."runtime_trace_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_events" ADD CONSTRAINT "runtime_trace_events_turn_id_runtime_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."runtime_trace_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_events" ADD CONSTRAINT "runtime_trace_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD CONSTRAINT "runtime_trace_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD CONSTRAINT "runtime_trace_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD CONSTRAINT "runtime_trace_sessions_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_tool_calls" ADD CONSTRAINT "runtime_trace_tool_calls_trace_session_id_runtime_trace_sessions_id_fk" FOREIGN KEY ("trace_session_id") REFERENCES "public"."runtime_trace_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_tool_calls" ADD CONSTRAINT "runtime_trace_tool_calls_turn_id_runtime_trace_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."runtime_trace_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_tool_calls" ADD CONSTRAINT "runtime_trace_tool_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_turns" ADD CONSTRAINT "runtime_trace_turns_trace_session_id_runtime_trace_sessions_id_fk" FOREIGN KEY ("trace_session_id") REFERENCES "public"."runtime_trace_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_turns" ADD CONSTRAINT "runtime_trace_turns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_turns" ADD CONSTRAINT "runtime_trace_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_sync_cursors_installation_domain_unique" ON "cloud_sync_cursors" USING btree ("organization_id","local_installation_id","project_scope","domain");--> statement-breakpoint
CREATE INDEX "cloud_sync_cursors_org_idx" ON "cloud_sync_cursors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "cloud_sync_cursors_installation_idx" ON "cloud_sync_cursors" USING btree ("local_installation_id");--> statement-breakpoint
CREATE INDEX "cloud_sync_cursors_project_idx" ON "cloud_sync_cursors" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_sync_events_sequence_unique" ON "cloud_sync_events" USING btree ("sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_sync_events_source_event_unique" ON "cloud_sync_events" USING btree ("organization_id","source_kind","source_id","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_sync_events_idempotency_unique" ON "cloud_sync_events" USING btree ("organization_id","source_kind","source_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "cloud_sync_events_org_sequence_idx" ON "cloud_sync_events" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE INDEX "cloud_sync_events_org_domain_sequence_idx" ON "cloud_sync_events" USING btree ("organization_id","domain","sequence");--> statement-breakpoint
CREATE INDEX "cloud_sync_events_project_domain_sequence_idx" ON "cloud_sync_events" USING btree ("project_id","domain","sequence");--> statement-breakpoint
CREATE INDEX "cloud_sync_events_entity_idx" ON "cloud_sync_events" USING btree ("organization_id","domain","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "cloud_sync_events_origin_installation_idx" ON "cloud_sync_events" USING btree ("origin_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_trace_blobs_session_kind_hash_unique" ON "runtime_trace_blobs" USING btree ("trace_session_id","kind","sha256");--> statement-breakpoint
CREATE INDEX "runtime_trace_blobs_org_idx" ON "runtime_trace_blobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_blobs_session_idx" ON "runtime_trace_blobs" USING btree ("trace_session_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_blobs_turn_idx" ON "runtime_trace_blobs" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_blobs_kind_idx" ON "runtime_trace_blobs" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "runtime_trace_blobs_sha_idx" ON "runtime_trace_blobs" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_trace_events_session_sequence_unique" ON "runtime_trace_events" USING btree ("trace_session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_trace_events_session_source_unique" ON "runtime_trace_events" USING btree ("trace_session_id","source_event_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_events_org_idx" ON "runtime_trace_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_events_session_idx" ON "runtime_trace_events" USING btree ("trace_session_id","sequence");--> statement-breakpoint
CREATE INDEX "runtime_trace_events_turn_idx" ON "runtime_trace_events" USING btree ("turn_id","sequence");--> statement-breakpoint
CREATE INDEX "runtime_trace_events_type_idx" ON "runtime_trace_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "runtime_trace_events_group_idx" ON "runtime_trace_events" USING btree ("event_group");--> statement-breakpoint
CREATE INDEX "runtime_trace_events_occurred_idx" ON "runtime_trace_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_trace_sessions_external_unique" ON "runtime_trace_sessions" USING btree ("organization_id","external_trace_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_sessions_org_started_idx" ON "runtime_trace_sessions" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "runtime_trace_sessions_project_started_idx" ON "runtime_trace_sessions" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "runtime_trace_sessions_status_idx" ON "runtime_trace_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runtime_trace_sessions_installation_idx" ON "runtime_trace_sessions" USING btree ("local_installation_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_sessions_session_key_idx" ON "runtime_trace_sessions" USING btree ("organization_id","session_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_trace_tool_calls_session_tool_unique" ON "runtime_trace_tool_calls" USING btree ("trace_session_id","tool_call_id") WHERE "runtime_trace_tool_calls"."tool_call_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runtime_trace_tool_calls_org_idx" ON "runtime_trace_tool_calls" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_tool_calls_session_idx" ON "runtime_trace_tool_calls" USING btree ("trace_session_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_tool_calls_turn_idx" ON "runtime_trace_tool_calls" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_tool_calls_status_idx" ON "runtime_trace_tool_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runtime_trace_tool_calls_name_idx" ON "runtime_trace_tool_calls" USING btree ("tool_name");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_trace_turns_session_sequence_unique" ON "runtime_trace_turns" USING btree ("trace_session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_trace_turns_session_source_unique" ON "runtime_trace_turns" USING btree ("trace_session_id","source_turn_id") WHERE "runtime_trace_turns"."source_turn_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runtime_trace_turns_org_idx" ON "runtime_trace_turns" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_turns_project_idx" ON "runtime_trace_turns" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_turns_session_idx" ON "runtime_trace_turns" USING btree ("trace_session_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_turns_status_idx" ON "runtime_trace_turns" USING btree ("status");
