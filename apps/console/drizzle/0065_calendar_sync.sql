-- Idempotent, like 0057-0063: a preview build may apply it to a shared
-- database before it merges.
CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_connection_id" uuid NOT NULL,
	"provider_calendar_id" text DEFAULT 'primary' NOT NULL,
	"provider_event_id" text NOT NULL,
	"ical_uid" text,
	"recurring_event_id" text,
	"title" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"meeting_url" text,
	"meeting_code" text,
	"organizer_email" text,
	"self_response" text,
	"attendees_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_attendees" boolean DEFAULT false NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"record_decision" text,
	"record_decision_project_id" uuid,
	"record_decided_at" timestamp with time zone,
	"meeting_bot_id" uuid,
	"record_error" text,
	"briefing_markdown" text,
	"briefing_updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_record_decision_check" CHECK ("calendar_events"."record_decision" IS NULL OR "calendar_events"."record_decision" IN ('record', 'skip'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_connection_id" uuid NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"record_mode" text,
	"project_id" uuid,
	"briefing_enabled" boolean,
	"briefing_minutes" integer DEFAULT 30 NOT NULL,
	"followup_enabled" boolean,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_settings_record_mode_check" CHECK ("calendar_settings"."record_mode" IS NULL OR "calendar_settings"."record_mode" IN ('off', 'ask', 'auto'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_record_decision_project_id_projects_id_fk" FOREIGN KEY ("record_decision_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_meeting_bot_id_meeting_bots_id_fk" FOREIGN KEY ("meeting_bot_id") REFERENCES "public"."meeting_bots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_events_connection_event_unique" ON "calendar_events" USING btree ("provider_connection_id","provider_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_user_start_idx" ON "calendar_events" USING btree ("organization_id","user_id","start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_meeting_idx" ON "calendar_events" USING btree ("organization_id","meeting_code","start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_start_idx" ON "calendar_events" USING btree ("start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_updated_idx" ON "calendar_events" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_settings_connection_unique" ON "calendar_settings" USING btree ("provider_connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_settings_user_idx" ON "calendar_settings" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_settings_sync_idx" ON "calendar_settings" USING btree ("sync_enabled","last_synced_at");