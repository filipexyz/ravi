CREATE TYPE "public"."managed_runtime_event_severity" AS ENUM('debug', 'info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."managed_runtime_instance_status" AS ENUM('provisioning', 'active', 'degraded', 'draining', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."managed_runtime_session_status" AS ENUM('starting', 'active', 'idle', 'completed', 'failed', 'interrupted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."runtime_host_status" AS ENUM('provisioning', 'active', 'degraded', 'draining', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."runtime_image_status" AS ENUM('building', 'active', 'deprecated', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."runtime_lease_status" AS ENUM('requested', 'assigned', 'booting', 'running', 'draining', 'completed', 'failed', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "managed_runtime_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid,
	"lease_id" uuid,
	"host_id" uuid,
	"sandbox_id" text,
	"source_event_id" text,
	"event_type" text NOT NULL,
	"sequence" bigint NOT NULL,
	"severity" "managed_runtime_event_severity" DEFAULT 'info' NOT NULL,
	"safe_payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_runtime_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"host_id" uuid,
	"image_id" uuid,
	"installation_id" uuid,
	"display_name" text NOT NULL,
	"status" "managed_runtime_instance_status" DEFAULT 'provisioning' NOT NULL,
	"runtime_version" text,
	"placement_class" text NOT NULL,
	"local_state_ref" text,
	"sync_cursor_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_runtime_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"instance_id" uuid,
	"lease_id" uuid,
	"host_id" uuid,
	"sandbox_id" text,
	"session_key" text,
	"runtime_provider" text NOT NULL,
	"runtime_model" text,
	"provider_session_state_json" jsonb,
	"status" "managed_runtime_session_status" DEFAULT 'starting' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"hostname" text NOT NULL,
	"region" text,
	"environment" "environment_name" DEFAULT 'development' NOT NULL,
	"status" "runtime_host_status" DEFAULT 'provisioning' NOT NULL,
	"placement_classes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capacity_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"architecture" text NOT NULL,
	"base_os" text NOT NULL,
	"provider_support_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kernel_ref" text NOT NULL,
	"rootfs_ref" text NOT NULL,
	"digest" text NOT NULL,
	"status" "runtime_image_status" DEFAULT 'building' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"agent_id" text,
	"session_key" text,
	"managed_runtime_instance_id" uuid,
	"runtime_provider" text NOT NULL,
	"runtime_model" text,
	"placement" text DEFAULT 'cloud' NOT NULL,
	"host_id" uuid,
	"image_id" uuid NOT NULL,
	"sandbox_id" text,
	"status" "runtime_lease_status" DEFAULT 'requested' NOT NULL,
	"lease_token_hash" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"limits_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_trace_blobs" ADD COLUMN "runtime_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "runtime_trace_blobs" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "runtime_trace_events" ADD COLUMN "runtime_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "runtime_trace_events" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD COLUMN "managed_runtime_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "runtime_trace_tool_calls" ADD COLUMN "runtime_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "runtime_trace_tool_calls" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "runtime_trace_turns" ADD COLUMN "runtime_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "runtime_trace_turns" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "managed_runtime_events" ADD CONSTRAINT "managed_runtime_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_events" ADD CONSTRAINT "managed_runtime_events_session_id_managed_runtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."managed_runtime_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_events" ADD CONSTRAINT "managed_runtime_events_lease_id_runtime_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."runtime_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_events" ADD CONSTRAINT "managed_runtime_events_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD CONSTRAINT "managed_runtime_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD CONSTRAINT "managed_runtime_instances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD CONSTRAINT "managed_runtime_instances_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD CONSTRAINT "managed_runtime_instances_image_id_runtime_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."runtime_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD CONSTRAINT "managed_runtime_instances_installation_id_local_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_sessions" ADD CONSTRAINT "managed_runtime_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_sessions" ADD CONSTRAINT "managed_runtime_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_sessions" ADD CONSTRAINT "managed_runtime_sessions_instance_id_managed_runtime_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."managed_runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_sessions" ADD CONSTRAINT "managed_runtime_sessions_lease_id_runtime_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."runtime_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_sessions" ADD CONSTRAINT "managed_runtime_sessions_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_leases" ADD CONSTRAINT "runtime_leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_leases" ADD CONSTRAINT "runtime_leases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_leases" ADD CONSTRAINT "runtime_leases_managed_runtime_instance_id_managed_runtime_instances_id_fk" FOREIGN KEY ("managed_runtime_instance_id") REFERENCES "public"."managed_runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_leases" ADD CONSTRAINT "runtime_leases_host_id_runtime_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."runtime_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_leases" ADD CONSTRAINT "runtime_leases_image_id_runtime_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."runtime_images"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_events_session_source_unique" ON "managed_runtime_events" USING btree ("session_id","source_event_id") WHERE "managed_runtime_events"."session_id" IS NOT NULL AND "managed_runtime_events"."source_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "managed_runtime_events_org_idx" ON "managed_runtime_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "managed_runtime_events_session_idx" ON "managed_runtime_events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "managed_runtime_events_lease_idx" ON "managed_runtime_events" USING btree ("lease_id","sequence");--> statement-breakpoint
CREATE INDEX "managed_runtime_events_type_idx" ON "managed_runtime_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "managed_runtime_instances_org_status_idx" ON "managed_runtime_instances" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "managed_runtime_instances_project_idx" ON "managed_runtime_instances" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "managed_runtime_instances_host_idx" ON "managed_runtime_instances" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "managed_runtime_instances_installation_idx" ON "managed_runtime_instances" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "managed_runtime_instances_heartbeat_idx" ON "managed_runtime_instances" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "managed_runtime_sessions_org_status_idx" ON "managed_runtime_sessions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "managed_runtime_sessions_project_idx" ON "managed_runtime_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "managed_runtime_sessions_instance_idx" ON "managed_runtime_sessions" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "managed_runtime_sessions_lease_idx" ON "managed_runtime_sessions" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "managed_runtime_sessions_session_key_idx" ON "managed_runtime_sessions" USING btree ("organization_id","session_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_hosts_hostname_unique" ON "runtime_hosts" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "runtime_hosts_status_idx" ON "runtime_hosts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runtime_hosts_provider_region_idx" ON "runtime_hosts" USING btree ("provider","region");--> statement-breakpoint
CREATE INDEX "runtime_hosts_heartbeat_idx" ON "runtime_hosts" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_images_digest_unique" ON "runtime_images" USING btree ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_images_name_version_arch_unique" ON "runtime_images" USING btree ("name","version","architecture");--> statement-breakpoint
CREATE INDEX "runtime_images_status_idx" ON "runtime_images" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_leases_token_hash_unique" ON "runtime_leases" USING btree ("lease_token_hash");--> statement-breakpoint
CREATE INDEX "runtime_leases_org_status_idx" ON "runtime_leases" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "runtime_leases_project_idx" ON "runtime_leases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runtime_leases_host_status_idx" ON "runtime_leases" USING btree ("host_id","status");--> statement-breakpoint
CREATE INDEX "runtime_leases_instance_idx" ON "runtime_leases" USING btree ("managed_runtime_instance_id");--> statement-breakpoint
CREATE INDEX "runtime_leases_expires_idx" ON "runtime_leases" USING btree ("lease_expires_at");--> statement-breakpoint
ALTER TABLE "runtime_trace_blobs" ADD CONSTRAINT "runtime_trace_blobs_runtime_lease_id_runtime_leases_id_fk" FOREIGN KEY ("runtime_lease_id") REFERENCES "public"."runtime_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_events" ADD CONSTRAINT "runtime_trace_events_runtime_lease_id_runtime_leases_id_fk" FOREIGN KEY ("runtime_lease_id") REFERENCES "public"."runtime_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_sessions" ADD CONSTRAINT "runtime_trace_sessions_managed_runtime_instance_id_managed_runtime_instances_id_fk" FOREIGN KEY ("managed_runtime_instance_id") REFERENCES "public"."managed_runtime_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_tool_calls" ADD CONSTRAINT "runtime_trace_tool_calls_runtime_lease_id_runtime_leases_id_fk" FOREIGN KEY ("runtime_lease_id") REFERENCES "public"."runtime_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_trace_turns" ADD CONSTRAINT "runtime_trace_turns_runtime_lease_id_runtime_leases_id_fk" FOREIGN KEY ("runtime_lease_id") REFERENCES "public"."runtime_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_trace_blobs_lease_idx" ON "runtime_trace_blobs" USING btree ("runtime_lease_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_events_lease_idx" ON "runtime_trace_events" USING btree ("runtime_lease_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_sessions_managed_instance_idx" ON "runtime_trace_sessions" USING btree ("managed_runtime_instance_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_tool_calls_lease_idx" ON "runtime_trace_tool_calls" USING btree ("runtime_lease_id");--> statement-breakpoint
CREATE INDEX "runtime_trace_turns_lease_idx" ON "runtime_trace_turns" USING btree ("runtime_lease_id");