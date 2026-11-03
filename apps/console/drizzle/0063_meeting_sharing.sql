-- Idempotent, like 0057-0062: a preview build may apply it to a shared
-- database before it merges. The new enum value is not used in this
-- migration (the check below compares object_type as text).
ALTER TYPE "public"."access_object_type" ADD VALUE IF NOT EXISTS 'meeting';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_grants" ALTER COLUMN "page_site_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grants" ADD COLUMN IF NOT EXISTS "meeting_bot_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_policies" ADD CONSTRAINT "organization_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_policies" ADD CONSTRAINT "organization_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_policies_org_key_unique" ON "organization_policies" USING btree ("organization_id","key");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_meeting_bot_id_meeting_bots_id_fk" FOREIGN KEY ("meeting_bot_id") REFERENCES "public"."meeting_bots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_grants_meeting_idx" ON "access_grants" USING btree ("meeting_bot_id");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_object_scope_check" CHECK (("access_grants"."object_type"::text IN ('page_site', 'page_route') AND "access_grants"."page_site_id" IS NOT NULL) OR ("access_grants"."object_type"::text = 'meeting' AND "access_grants"."meeting_bot_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
