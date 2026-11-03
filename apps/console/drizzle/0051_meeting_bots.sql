CREATE TYPE "public"."meeting_bot_status" AS ENUM('requested', 'joining', 'waiting_room', 'in_call', 'recording', 'ended', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "meeting_bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"requested_by_user_id" uuid,
	"local_installation_id" uuid,
	"provider" text DEFAULT 'recall' NOT NULL,
	"provider_bot_id" text,
	"platform" text NOT NULL,
	"meeting_url" text NOT NULL,
	"meeting_code" text,
	"bot_name" text NOT NULL,
	"title" text,
	"language" text NOT NULL,
	"client_ref" text,
	"status" "meeting_bot_status" DEFAULT 'requested' NOT NULL,
	"status_sub_code" text,
	"transcript_status" text DEFAULT 'pending' NOT NULL,
	"join_at" timestamp with time zone,
	"recording_started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"recording_seconds" integer,
	"max_recording_seconds" integer NOT NULL,
	"ready_notified_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_bots" ADD CONSTRAINT "meeting_bots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_bots" ADD CONSTRAINT "meeting_bots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_bots" ADD CONSTRAINT "meeting_bots_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_bots" ADD CONSTRAINT "meeting_bots_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_bots_provider_bot_unique" ON "meeting_bots" USING btree ("provider","provider_bot_id") WHERE "meeting_bots"."provider_bot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "meeting_bots_org_created_idx" ON "meeting_bots" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "meeting_bots_org_status_idx" ON "meeting_bots" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "meeting_bots_project_idx" ON "meeting_bots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "meeting_bots_installation_idx" ON "meeting_bots" USING btree ("local_installation_id");--> statement-breakpoint
-- Cloud meeting recording starts on for every organization that exists today
-- and off for organizations created later (console.meetings is
-- entitlement-required). An organization that already has a console.meetings
-- row keeps it.
WITH granted AS (
  INSERT INTO "entitlements" ("organization_id", "key", "value_json", "source")
  SELECT "id", 'console.meetings', '{"enabled": true}'::jsonb, 'meetings_rollout'
  FROM "organizations"
  ON CONFLICT ("organization_id", "key") DO NOTHING
  RETURNING "id", "organization_id"
)
INSERT INTO "audit_events" ("organization_id", "actor_type", "target_type", "target_id", "action", "after_json", "metadata_json")
SELECT "organization_id", 'system', 'entitlement', "id"::text, 'admin.entitlement.granted',
  '{"key": "console.meetings", "valueJson": {"enabled": true}, "source": "meetings_rollout"}'::jsonb,
  '{"featureKey": "console.meetings", "reason": "Cloud meeting recording rollout to existing organizations", "source": "meetings_rollout"}'::jsonb
FROM granted;
