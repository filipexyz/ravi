CREATE TYPE "public"."ravi_control_chat_binding_status" AS ENUM('pending', 'active', 'stale', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."ravi_control_message_mirror_status" AS ENUM('queued', 'accepted', 'canonical', 'failed');--> statement-breakpoint
ALTER TYPE "public"."managed_runtime_command_action" ADD VALUE 'chat_message_create';--> statement-breakpoint
ALTER TYPE "public"."managed_runtime_command_action" ADD VALUE 'chat_sync';--> statement-breakpoint
CREATE TABLE "ravi_control_chat_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"instance_id" uuid NOT NULL,
	"actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"actor_id" text NOT NULL,
	"target_agent_id" text NOT NULL,
	"local_actor_id" text,
	"local_platform_identity_id" text,
	"local_chat_id" text,
	"local_session_key" text,
	"binding_version" integer DEFAULT 1 NOT NULL,
	"status" "ravi_control_chat_binding_status" DEFAULT 'pending' NOT NULL,
	"chat_cursor" text,
	"session_cursor" text,
	"last_synced_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ravi_control_message_mirrors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"instance_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"command_id" uuid,
	"local_message_id" text,
	"client_message_id" text NOT NULL,
	"reply_to_local_message_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"status" "ravi_control_message_mirror_status" DEFAULT 'queued' NOT NULL,
	"cursor" text,
	"encrypted_content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" text,
	"local_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "managed_runtime_commands_session_execution_active_unique";--> statement-breakpoint
ALTER TABLE "ravi_control_chat_bindings" ADD CONSTRAINT "ravi_control_chat_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_control_chat_bindings" ADD CONSTRAINT "ravi_control_chat_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_control_chat_bindings" ADD CONSTRAINT "ravi_control_chat_bindings_instance_id_managed_runtime_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."managed_runtime_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_control_message_mirrors" ADD CONSTRAINT "ravi_control_message_mirrors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_control_message_mirrors" ADD CONSTRAINT "ravi_control_message_mirrors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_control_message_mirrors" ADD CONSTRAINT "ravi_control_message_mirrors_instance_id_managed_runtime_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."managed_runtime_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_control_message_mirrors" ADD CONSTRAINT "ravi_control_message_mirrors_binding_id_ravi_control_chat_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."ravi_control_chat_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_control_message_mirrors" ADD CONSTRAINT "ravi_control_message_mirrors_command_id_managed_runtime_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."managed_runtime_commands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ravi_control_chat_bindings_principal_unique" ON "ravi_control_chat_bindings" USING btree ("organization_id","instance_id","actor_id","target_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ravi_control_chat_bindings_local_chat_unique" ON "ravi_control_chat_bindings" USING btree ("instance_id","local_chat_id") WHERE "ravi_control_chat_bindings"."local_chat_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ravi_control_chat_bindings_org_status_idx" ON "ravi_control_chat_bindings" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ravi_control_chat_bindings_project_idx" ON "ravi_control_chat_bindings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ravi_control_chat_bindings_instance_idx" ON "ravi_control_chat_bindings" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ravi_control_message_mirrors_client_unique" ON "ravi_control_message_mirrors" USING btree ("binding_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ravi_control_message_mirrors_local_unique" ON "ravi_control_message_mirrors" USING btree ("binding_id","local_message_id") WHERE "ravi_control_message_mirrors"."local_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ravi_control_message_mirrors_binding_created_idx" ON "ravi_control_message_mirrors" USING btree ("binding_id","created_at");--> statement-breakpoint
CREATE INDEX "ravi_control_message_mirrors_command_idx" ON "ravi_control_message_mirrors" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "ravi_control_message_mirrors_org_status_idx" ON "ravi_control_message_mirrors" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_runtime_commands_session_execution_active_unique" ON "managed_runtime_commands" USING btree ("session_id") WHERE "managed_runtime_commands"."session_id" IS NOT NULL AND "managed_runtime_commands"."action" <> 'turn_interrupt' AND "managed_runtime_commands"."status" IN ('pending', 'claimed', 'running');