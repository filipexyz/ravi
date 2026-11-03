CREATE TYPE "public"."managed_runtime_connection_kind" AS ENUM('private_ravi_sdk', 'remote_relay');--> statement-breakpoint
CREATE TYPE "public"."managed_runtime_connection_status" AS ENUM('connecting', 'online', 'stale', 'offline', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."managed_runtime_desired_state" AS ENUM('running', 'stopped', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."managed_runtime_observed_state" AS ENUM('provisioning', 'starting', 'ready', 'stopping', 'stopped', 'restarting', 'degraded', 'deleting', 'deleted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."managed_runtime_operation_action" AS ENUM('create', 'start', 'stop', 'restart', 'retry', 'delete', 'backup', 'restore', 'rotate_controller');--> statement-breakpoint
CREATE TYPE "public"."managed_runtime_operation_status" AS ENUM('pending', 'claimed', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "managed_runtime_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"kind" "managed_runtime_connection_kind" NOT NULL,
	"status" "managed_runtime_connection_status" DEFAULT 'connecting' NOT NULL,
	"protocol_version" text NOT NULL,
	"safe_endpoint_ref" text,
	"credential_ref" text,
	"last_connected_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_runtime_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"instance_id" uuid NOT NULL,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"action" "managed_runtime_operation_action" NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "managed_runtime_operation_status" DEFAULT 'pending' NOT NULL,
	"phase" text,
	"progress_percent" integer,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"safe_input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_result_json" jsonb,
	"failure_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD COLUMN "desired_state" "managed_runtime_desired_state" DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD COLUMN "observed_state" "managed_runtime_observed_state" DEFAULT 'provisioning' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD COLUMN "provisioning_phase" text;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD COLUMN "runtime_provider" text DEFAULT 'codex' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_runtime_instances" ADD COLUMN "runtime_model" text;--> statement-breakpoint
UPDATE "managed_runtime_instances"
SET
	"desired_state" = CASE
		WHEN "status" = 'disabled' THEN 'stopped'::"managed_runtime_desired_state"
		WHEN "status" = 'deleted' THEN 'deleted'::"managed_runtime_desired_state"
		ELSE 'running'::"managed_runtime_desired_state"
	END,
	"observed_state" = CASE
		WHEN "status" = 'active' THEN 'ready'::"managed_runtime_observed_state"
		WHEN "status" = 'degraded' THEN 'degraded'::"managed_runtime_observed_state"
		WHEN "status" = 'draining' THEN 'stopping'::"managed_runtime_observed_state"
		WHEN "status" = 'disabled' THEN 'stopped'::"managed_runtime_observed_state"
		WHEN "status" = 'deleted' THEN 'deleted'::"managed_runtime_observed_state"
		ELSE 'provisioning'::"managed_runtime_observed_state"
	END;--> statement-breakpoint
ALTER TABLE "managed_runtime_connections" ADD CONSTRAINT "managed_runtime_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_connections" ADD CONSTRAINT "managed_runtime_connections_instance_id_managed_runtime_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."managed_runtime_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_operations" ADD CONSTRAINT "managed_runtime_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_operations" ADD CONSTRAINT "managed_runtime_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_operations" ADD CONSTRAINT "managed_runtime_operations_instance_id_managed_runtime_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."managed_runtime_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_connections_instance_kind_unique" ON "managed_runtime_connections" USING btree ("instance_id","kind");--> statement-breakpoint
CREATE INDEX "managed_runtime_connections_org_status_idx" ON "managed_runtime_connections" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "managed_runtime_connections_heartbeat_idx" ON "managed_runtime_connections" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_operations_org_action_idempotency_unique" ON "managed_runtime_operations" USING btree ("organization_id","action","idempotency_key");--> statement-breakpoint
CREATE INDEX "managed_runtime_operations_instance_created_idx" ON "managed_runtime_operations" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE INDEX "managed_runtime_operations_claim_idx" ON "managed_runtime_operations" USING btree ("status","claim_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "managed_runtime_operations_project_idx" ON "managed_runtime_operations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "managed_runtime_instances_org_desired_observed_idx" ON "managed_runtime_instances" USING btree ("organization_id","desired_state","observed_state");
