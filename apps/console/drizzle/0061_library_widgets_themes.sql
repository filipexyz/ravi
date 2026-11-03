-- Idempotent, like 0057-0060: a preview build may apply it to a shared
-- database before it merges. New enum values are not used in this migration.
ALTER TYPE "public"."library_item_kind" ADD VALUE IF NOT EXISTS 'theme';
--> statement-breakpoint
ALTER TYPE "public"."library_item_kind" ADD VALUE IF NOT EXISTS 'widget';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_theme_pointers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"item_id" uuid NOT NULL,
	"set_by_user_id" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_theme_pointers" ADD CONSTRAINT "library_theme_pointers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_theme_pointers" ADD CONSTRAINT "library_theme_pointers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_theme_pointers" ADD CONSTRAINT "library_theme_pointers_item_id_library_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_theme_pointers" ADD CONSTRAINT "library_theme_pointers_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_theme_pointers_org_unique" ON "library_theme_pointers" USING btree ("organization_id") WHERE "library_theme_pointers"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_theme_pointers_project_unique" ON "library_theme_pointers" USING btree ("organization_id","project_id") WHERE "library_theme_pointers"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_theme_pointers_item_idx" ON "library_theme_pointers" USING btree ("item_id");
