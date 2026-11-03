-- Idempotent, like 0057-0063: a preview build may apply it to a shared
-- database before it merges.
CREATE TABLE IF NOT EXISTS "page_chat_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"for_user_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"input_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" uuid,
	"author_name" text NOT NULL,
	"author_role" text,
	"body" text DEFAULT '' NOT NULL,
	"parts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"source" text DEFAULT 'text' NOT NULL,
	"client_message_id" text,
	"anchor_json" jsonb,
	"turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_chat_reads" (
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_chat_reads_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_chat_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" uuid,
	"path" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_chat_rooms_kind_check" CHECK (("page_chat_rooms"."kind" = 'shared' AND "page_chat_rooms"."owner_user_id" IS NULL) OR ("page_chat_rooms"."kind" = 'private' AND "page_chat_rooms"."owner_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_chat_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"reply_message_id" uuid,
	"speaker_user_id" uuid NOT NULL,
	"speaker_kind" text NOT NULL,
	"speaker_org_role" text,
	"pages_session_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_id" text,
	"model" text NOT NULL,
	"state_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(20, 8),
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_confirmations" ADD CONSTRAINT "page_chat_confirmations_room_id_page_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."page_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_confirmations" ADD CONSTRAINT "page_chat_confirmations_turn_id_page_chat_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."page_chat_turns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_confirmations" ADD CONSTRAINT "page_chat_confirmations_message_id_page_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."page_chat_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_confirmations" ADD CONSTRAINT "page_chat_confirmations_for_user_id_users_id_fk" FOREIGN KEY ("for_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_messages" ADD CONSTRAINT "page_chat_messages_room_id_page_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."page_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_messages" ADD CONSTRAINT "page_chat_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_messages" ADD CONSTRAINT "page_chat_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_reads" ADD CONSTRAINT "page_chat_reads_room_id_page_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."page_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_reads" ADD CONSTRAINT "page_chat_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_rooms" ADD CONSTRAINT "page_chat_rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_rooms" ADD CONSTRAINT "page_chat_rooms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_rooms" ADD CONSTRAINT "page_chat_rooms_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_rooms" ADD CONSTRAINT "page_chat_rooms_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_rooms" ADD CONSTRAINT "page_chat_rooms_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_turns" ADD CONSTRAINT "page_chat_turns_room_id_page_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."page_chat_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_turns" ADD CONSTRAINT "page_chat_turns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_turns" ADD CONSTRAINT "page_chat_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_turns" ADD CONSTRAINT "page_chat_turns_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_turns" ADD CONSTRAINT "page_chat_turns_trigger_message_id_page_chat_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."page_chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_turns" ADD CONSTRAINT "page_chat_turns_reply_message_id_page_chat_messages_id_fk" FOREIGN KEY ("reply_message_id") REFERENCES "public"."page_chat_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "page_chat_turns" ADD CONSTRAINT "page_chat_turns_speaker_user_id_users_id_fk" FOREIGN KEY ("speaker_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_confirmations_turn_idx" ON "page_chat_confirmations" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_confirmations_room_status_idx" ON "page_chat_confirmations" USING btree ("room_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_chat_messages_room_seq_unique" ON "page_chat_messages" USING btree ("room_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_chat_messages_client_unique" ON "page_chat_messages" USING btree ("room_id","author_user_id","client_message_id") WHERE "page_chat_messages"."client_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_messages_org_idx" ON "page_chat_messages" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_messages_author_idx" ON "page_chat_messages" USING btree ("author_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_chat_rooms_shared_unique" ON "page_chat_rooms" USING btree ("route_id") WHERE "page_chat_rooms"."kind" = 'shared';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "page_chat_rooms_private_unique" ON "page_chat_rooms" USING btree ("route_id","owner_user_id") WHERE "page_chat_rooms"."kind" = 'private';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_rooms_org_idx" ON "page_chat_rooms" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_rooms_site_idx" ON "page_chat_rooms" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_turns_room_idx" ON "page_chat_turns" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_turns_org_created_idx" ON "page_chat_turns" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_chat_turns_speaker_idx" ON "page_chat_turns" USING btree ("speaker_user_id","created_at");