CREATE TYPE "public"."managed_runtime_command_action" AS ENUM('session_sync', 'prompt_send', 'turn_interrupt');--> statement-breakpoint
CREATE TYPE "public"."managed_runtime_command_status" AS ENUM('pending', 'claimed', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "managed_runtime_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"instance_id" uuid NOT NULL,
	"session_id" uuid,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"action" "managed_runtime_command_action" NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "managed_runtime_command_status" DEFAULT 'pending' NOT NULL,
	"phase" text,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"encrypted_input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_result_json" jsonb,
	"safe_result_json" jsonb,
	"failure_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_runtime_events" ADD COLUMN "command_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_runtime_events" ADD COLUMN "encrypted_payload_json" jsonb;--> statement-breakpoint
ALTER TABLE "managed_runtime_commands" ADD CONSTRAINT "managed_runtime_commands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_commands" ADD CONSTRAINT "managed_runtime_commands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_commands" ADD CONSTRAINT "managed_runtime_commands_instance_id_managed_runtime_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."managed_runtime_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_runtime_commands" ADD CONSTRAINT "managed_runtime_commands_session_id_managed_runtime_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."managed_runtime_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_commands_org_action_idempotency_unique" ON "managed_runtime_commands" USING btree ("organization_id","action","idempotency_key");--> statement-breakpoint
CREATE INDEX "managed_runtime_commands_claim_idx" ON "managed_runtime_commands" USING btree ("status","claim_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "managed_runtime_commands_instance_created_idx" ON "managed_runtime_commands" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE INDEX "managed_runtime_commands_session_created_idx" ON "managed_runtime_commands" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_commands_session_execution_active_unique" ON "managed_runtime_commands" USING btree ("session_id") WHERE "managed_runtime_commands"."session_id" IS NOT NULL AND "managed_runtime_commands"."action" IN ('session_sync', 'prompt_send') AND "managed_runtime_commands"."status" IN ('pending', 'claimed', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_commands_session_interrupt_active_unique" ON "managed_runtime_commands" USING btree ("session_id") WHERE "managed_runtime_commands"."session_id" IS NOT NULL AND "managed_runtime_commands"."action" = 'turn_interrupt' AND "managed_runtime_commands"."status" IN ('pending', 'claimed', 'running');--> statement-breakpoint
CREATE INDEX "managed_runtime_commands_project_idx" ON "managed_runtime_commands" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "managed_runtime_events" ADD CONSTRAINT "managed_runtime_events_command_id_managed_runtime_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."managed_runtime_commands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_runtime_events_command_idx" ON "managed_runtime_events" USING btree ("command_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_sessions_instance_session_key_unique" ON "managed_runtime_sessions" USING btree ("instance_id","session_key") WHERE "managed_runtime_sessions"."instance_id" IS NOT NULL AND "managed_runtime_sessions"."session_key" IS NOT NULL;