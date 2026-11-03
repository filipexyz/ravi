-- Idempotent: a preview build may already have applied this migration as
-- 0055_library to a shared database before it was renumbered.
DO $$ BEGIN
  CREATE TYPE "public"."library_item_kind" AS ENUM('skill', 'agent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."library_version_status" AS ENUM('draft', 'proposed', 'published', 'rejected', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" "library_item_kind" DEFAULT 'skill' NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"external_allowed" boolean DEFAULT false NOT NULL,
	"current_version_id" uuid,
	"current_version_number" integer,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"archived_by_user_id" uuid,
	"created_by_user_id" uuid,
	"search_text" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "library_version_status" DEFAULT 'published' NOT NULL,
	"content_hash" text NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"note" text,
	"author_type" text DEFAULT 'user' NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" text,
	"local_installation_id" uuid,
	"published_at" timestamp with time zone,
	"published_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_files" ADD CONSTRAINT "library_files_version_id_library_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."library_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_items" ADD CONSTRAINT "library_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_items" ADD CONSTRAINT "library_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_items" ADD CONSTRAINT "library_items_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_items" ADD CONSTRAINT "library_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_versions" ADD CONSTRAINT "library_versions_item_id_library_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_versions" ADD CONSTRAINT "library_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_versions" ADD CONSTRAINT "library_versions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_versions" ADD CONSTRAINT "library_versions_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_versions" ADD CONSTRAINT "library_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_files_version_path_unique" ON "library_files" USING btree ("version_id","path");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_items_org_scope_slug_unique" ON "library_items" USING btree ("organization_id","kind","slug") WHERE "library_items"."project_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_items_project_scope_slug_unique" ON "library_items" USING btree ("organization_id","kind","project_id","slug") WHERE "library_items"."project_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_items_org_project_idx" ON "library_items" USING btree ("organization_id","project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_items_search_idx" ON "library_items" USING gin ("search_vector");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_versions_item_number_unique" ON "library_versions" USING btree ("item_id","version_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_versions_item_status_idx" ON "library_versions" USING btree ("item_id","status");
