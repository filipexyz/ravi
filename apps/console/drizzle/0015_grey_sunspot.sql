CREATE TYPE "public"."mcp_bridge_event_status_class" AS ENUM('ok', 'client_error', 'server_error', 'upstream_unavailable');--> statement-breakpoint
CREATE TYPE "public"."mcp_bridge_event_type" AS ENUM('connect', 'disconnect', 'initialize', 'tools_list', 'tools_call', 'resources_read', 'prompts_get', 'error', 'daemon_offline', 'rate_limited');--> statement-breakpoint
CREATE TYPE "public"."mcp_bridge_status" AS ENUM('active', 'revoked', 'paused');--> statement-breakpoint
CREATE TYPE "public"."mcp_oauth_client_auth_method" AS ENUM('none', 'client_secret_basic');--> statement-breakpoint
CREATE TABLE "mcp_bridge_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bridge_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_type" "mcp_bridge_event_type" NOT NULL,
	"tool_name" text,
	"model" text,
	"tokens_input" integer,
	"tokens_output" integer,
	"cost_estimate_usd" numeric(10, 6),
	"duration_ms" integer NOT NULL,
	"status_class" "mcp_bridge_event_status_class" NOT NULL,
	"request_id" text NOT NULL,
	"oauth_client_id" uuid,
	"client_user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_bridge_usage" (
	"bridge_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"calls_total" integer DEFAULT 0 NOT NULL,
	"calls_ok" integer DEFAULT 0 NOT NULL,
	"calls_error" integer DEFAULT 0 NOT NULL,
	"tokens_input_total" bigint DEFAULT 0 NOT NULL,
	"tokens_output_total" bigint DEFAULT 0 NOT NULL,
	"cost_estimate_total_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"unique_clients" integer DEFAULT 0 NOT NULL,
	"daemon_offline_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_bridge_usage_pk" PRIMARY KEY("bridge_id","day")
);
--> statement-breakpoint
CREATE TABLE "mcp_bridges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"session_ref" text NOT NULL,
	"channel_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "mcp_bridge_status" DEFAULT 'active' NOT NULL,
	"bridge_token_hash" text NOT NULL,
	"previous_bridge_token_hash" text,
	"last_url_rotation_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allowed_capability_classes_json" jsonb DEFAULT '["read"]'::jsonb NOT NULL,
	"rate_limit_overrides_json" jsonb,
	"cached_tools_json" jsonb,
	"cached_tools_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"bridge_id" uuid NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"subject_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"bridge_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"client_name" text NOT NULL,
	"software_id" text,
	"software_version" text,
	"redirect_uris_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_types_json" jsonb DEFAULT '["authorization_code","refresh_token"]'::jsonb NOT NULL,
	"token_endpoint_auth_method" "mcp_oauth_client_auth_method" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"bridge_id" uuid NOT NULL,
	"oauth_client_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"device_label" text,
	"rotated_from_token_id" uuid,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_bridge_events" ADD CONSTRAINT "mcp_bridge_events_bridge_id_mcp_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."mcp_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridge_events" ADD CONSTRAINT "mcp_bridge_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridge_events" ADD CONSTRAINT "mcp_bridge_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridge_events" ADD CONSTRAINT "mcp_bridge_events_oauth_client_id_mcp_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridge_usage" ADD CONSTRAINT "mcp_bridge_usage_bridge_id_mcp_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."mcp_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridge_usage" ADD CONSTRAINT "mcp_bridge_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridge_usage" ADD CONSTRAINT "mcp_bridge_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridges" ADD CONSTRAINT "mcp_bridges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridges" ADD CONSTRAINT "mcp_bridges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_bridges" ADD CONSTRAINT "mcp_bridges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_bridge_id_mcp_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."mcp_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_oauth_client_id_mcp_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_bridge_id_mcp_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."mcp_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_bridge_id_mcp_bridges_id_fk" FOREIGN KEY ("bridge_id") REFERENCES "public"."mcp_bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_oauth_client_id_mcp_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_bridge_events_org_idx" ON "mcp_bridge_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mcp_bridge_events_project_idx" ON "mcp_bridge_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mcp_bridge_events_bridge_occurred_idx" ON "mcp_bridge_events" USING btree ("bridge_id","occurred_at");--> statement-breakpoint
CREATE INDEX "mcp_bridge_events_type_idx" ON "mcp_bridge_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "mcp_bridge_events_client_idx" ON "mcp_bridge_events" USING btree ("oauth_client_id");--> statement-breakpoint
CREATE INDEX "mcp_bridge_events_request_idx" ON "mcp_bridge_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "mcp_bridge_usage_org_day_idx" ON "mcp_bridge_usage" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX "mcp_bridge_usage_project_day_idx" ON "mcp_bridge_usage" USING btree ("project_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_bridges_token_hash_unique" ON "mcp_bridges" USING btree ("bridge_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_bridges_previous_token_hash_unique" ON "mcp_bridges" USING btree ("previous_bridge_token_hash") WHERE "mcp_bridges"."previous_bridge_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mcp_bridges_org_idx" ON "mcp_bridges" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mcp_bridges_project_idx" ON "mcp_bridges" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mcp_bridges_created_by_idx" ON "mcp_bridges" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "mcp_bridges_status_idx" ON "mcp_bridges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mcp_bridges_last_used_idx" ON "mcp_bridges" USING btree ("last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_authorizations_code_hash_unique" ON "mcp_oauth_authorizations" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_org_idx" ON "mcp_oauth_authorizations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_project_idx" ON "mcp_oauth_authorizations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_bridge_idx" ON "mcp_oauth_authorizations" USING btree ("bridge_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_client_idx" ON "mcp_oauth_authorizations" USING btree ("oauth_client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_subject_idx" ON "mcp_oauth_authorizations" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_expires_idx" ON "mcp_oauth_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_clients_client_id_unique" ON "mcp_oauth_clients" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_clients_org_idx" ON "mcp_oauth_clients" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_clients_project_idx" ON "mcp_oauth_clients" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_clients_bridge_idx" ON "mcp_oauth_clients" USING btree ("bridge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_tokens_access_hash_unique" ON "mcp_oauth_tokens" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_tokens_refresh_hash_unique" ON "mcp_oauth_tokens" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_org_idx" ON "mcp_oauth_tokens" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_project_idx" ON "mcp_oauth_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_bridge_idx" ON "mcp_oauth_tokens" USING btree ("bridge_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_client_idx" ON "mcp_oauth_tokens" USING btree ("oauth_client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_subject_idx" ON "mcp_oauth_tokens" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_revoked_idx" ON "mcp_oauth_tokens" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_access_expires_idx" ON "mcp_oauth_tokens" USING btree ("access_token_expires_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_refresh_expires_idx" ON "mcp_oauth_tokens" USING btree ("refresh_token_expires_at");