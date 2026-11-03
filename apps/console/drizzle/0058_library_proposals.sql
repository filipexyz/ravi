-- Idempotent, like 0057: a preview build may apply it to a shared database
-- before it merges.
ALTER TYPE "public"."library_version_status" ADD VALUE IF NOT EXISTS 'withdrawn';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"parent_id" uuid,
	"path" text,
	"line" integer,
	"round" integer NOT NULL,
	"body" text NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_versions" ALTER COLUMN "version_number" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "proposal_number" integer;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "base_version_number" integer;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "round" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "name" text;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "external_allowed" boolean;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "proposed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "decided_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "library_versions" ADD COLUMN IF NOT EXISTS "decision_reason" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_comments" ADD CONSTRAINT "library_comments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_comments" ADD CONSTRAINT "library_comments_item_id_library_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."library_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_comments" ADD CONSTRAINT "library_comments_version_id_library_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."library_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_comments" ADD CONSTRAINT "library_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_comments" ADD CONSTRAINT "library_comments_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_comments" ADD CONSTRAINT "library_comments_parent_id_library_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."library_comments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_comments_version_idx" ON "library_comments" USING btree ("version_id","created_at");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_versions" ADD CONSTRAINT "library_versions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_versions_item_proposal_unique" ON "library_versions" USING btree ("item_id","proposal_number") WHERE "library_versions"."proposal_number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_versions_org_status_idx" ON "library_versions" USING btree ("organization_id","status");
