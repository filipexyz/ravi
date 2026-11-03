-- Idempotent, like 0057-0067: a preview build may apply it to a shared
-- database before it merges. Cloud agents on Claude Managed Agents
-- (spec console/managed-runtime/claude-managed-agents).
CREATE TABLE IF NOT EXISTS "cloud_agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret_encrypted" text,
	"key_hint" text,
	"status" text DEFAULT 'active' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_error" text,
	"monthly_alert_usd" integer,
	"alerted_month" text,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"library_item_id" uuid NOT NULL,
	"library_version_id" uuid,
	"library_version_number" integer,
	"name" text NOT NULL,
	"provider" text DEFAULT 'anthropic' NOT NULL,
	"model" text,
	"provider_agent_id" text,
	"provider_agent_version" integer,
	"provider_environment_id" text,
	"skills_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"compiled_hash" text,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"last_error" text,
	"last_error_code" text,
	"deployed_by_user_id" uuid,
	"deployed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"library_version_id" uuid,
	"provider" text DEFAULT 'anthropic' NOT NULL,
	"provider_session_id" text,
	"provider_vault_id" text,
	"provider_vault_credential_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"schedule_id" uuid,
	"prompt_encrypted" text NOT NULL,
	"result_encrypted" text,
	"budget_usd_cents" integer NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"running_seconds" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"event_cursor" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"mcp_token_id" uuid,
	"runtime_trace_session_id" uuid,
	"origin_json" jsonb,
	"idempotency_key" text,
	"request_hash" text,
	"usage_recorded_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"hard_end_at" timestamp with time zone NOT NULL,
	"provider_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_agent_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"server_name" text,
	"input_hash" text NOT NULL,
	"input_preview_encrypted" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"consumed_at" timestamp with time zone,
	"inbox_item_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cloud_agent_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"cron" text NOT NULL,
	"timezone" text NOT NULL,
	"prompt_encrypted" text,
	"actor_user_id" uuid NOT NULL,
	"budget_usd_cents" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_credentials" ADD CONSTRAINT "cloud_agent_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_credentials" ADD CONSTRAINT "cloud_agent_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_credentials" ADD CONSTRAINT "cloud_agent_credentials_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agents" ADD CONSTRAINT "cloud_agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agents" ADD CONSTRAINT "cloud_agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agents" ADD CONSTRAINT "cloud_agents_library_item_id_library_items_id_fk" FOREIGN KEY ("library_item_id") REFERENCES "public"."library_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agents" ADD CONSTRAINT "cloud_agents_library_version_id_library_versions_id_fk" FOREIGN KEY ("library_version_id") REFERENCES "public"."library_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agents" ADD CONSTRAINT "cloud_agents_deployed_by_user_id_users_id_fk" FOREIGN KEY ("deployed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_agent_id_cloud_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."cloud_agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_library_version_id_library_versions_id_fk" FOREIGN KEY ("library_version_id") REFERENCES "public"."library_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_runs" ADD CONSTRAINT "cloud_agent_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_approvals" ADD CONSTRAINT "cloud_agent_approvals_run_id_cloud_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."cloud_agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_approvals" ADD CONSTRAINT "cloud_agent_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_approvals" ADD CONSTRAINT "cloud_agent_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_schedules" ADD CONSTRAINT "cloud_agent_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_schedules" ADD CONSTRAINT "cloud_agent_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_schedules" ADD CONSTRAINT "cloud_agent_schedules_agent_id_cloud_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."cloud_agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "cloud_agent_schedules" ADD CONSTRAINT "cloud_agent_schedules_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_agent_credentials_org_provider_unique" ON "cloud_agent_credentials" USING btree ("organization_id","provider") WHERE "cloud_agent_credentials"."status" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_agents_project_item_unique" ON "cloud_agents" USING btree ("project_id","library_item_id") WHERE "cloud_agents"."status" <> 'archived';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agents_org_idx" ON "cloud_agents" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_agent_runs_org_idempotency_unique" ON "cloud_agent_runs" USING btree ("organization_id","idempotency_key") WHERE "cloud_agent_runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_runs_project_started_idx" ON "cloud_agent_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_runs_agent_started_idx" ON "cloud_agent_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_runs_status_idx" ON "cloud_agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_runs_actor_idx" ON "cloud_agent_runs" USING btree ("actor_user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_runs_mcp_token_idx" ON "cloud_agent_runs" USING btree ("mcp_token_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_runs_ended_idx" ON "cloud_agent_runs" USING btree ("ended_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_agent_approvals_run_event_unique" ON "cloud_agent_approvals" USING btree ("run_id","provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_approvals_run_status_idx" ON "cloud_agent_approvals" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_approvals_status_expires_idx" ON "cloud_agent_approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_schedules_due_idx" ON "cloud_agent_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_schedules_project_idx" ON "cloud_agent_schedules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cloud_agent_schedules_agent_idx" ON "cloud_agent_schedules" USING btree ("agent_id");
