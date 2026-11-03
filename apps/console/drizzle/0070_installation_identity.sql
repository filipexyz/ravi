-- Idempotent, like 0057-0069: a preview build may apply it to a shared
-- database before it merges.
-- Installation identity (spec console/managed-runtime/installations): an
-- installation belongs to the organization, bootstraps from a single-use
-- token, pulls desired state and reports a derived summary. Person logins
-- keep `subject_type = user`.
DO $$ BEGIN
  CREATE TYPE "public"."installation_subject_type" AS ENUM('user', 'installation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."installation_state" AS ENUM('requested', 'bootstrapped', 'configured', 'healthy', 'live', 'blocked_human', 'drifted', 'degraded', 'revoked', 'decommissioned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TYPE "public"."local_installation_status" ADD VALUE IF NOT EXISTS 'decommissioned';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "installation_bootstrap_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "cli_sessions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "local_installations" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD COLUMN IF NOT EXISTS "subject_type" "installation_subject_type" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "subject_type" "installation_subject_type" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "install_state" "installation_state" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "install_state_reason" text;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "desired_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "desired_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "desired_hash" text;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "applied_hash" text;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "observed_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "state_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "decommissioned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN IF NOT EXISTS "decommission_reason" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "installation_bootstrap_tokens" ADD CONSTRAINT "installation_bootstrap_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "installation_bootstrap_tokens" ADD CONSTRAINT "installation_bootstrap_tokens_installation_id_local_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "installation_bootstrap_tokens" ADD CONSTRAINT "installation_bootstrap_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "installation_bootstrap_tokens_hash_unique" ON "installation_bootstrap_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "installation_bootstrap_tokens_installation_idx" ON "installation_bootstrap_tokens" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "installation_bootstrap_tokens_org_idx" ON "installation_bootstrap_tokens" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "installation_bootstrap_tokens_expires_idx" ON "installation_bootstrap_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cli_sessions_subject_idx" ON "cli_sessions" USING btree ("subject_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_installations_subject_idx" ON "local_installations" USING btree ("subject_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_installations_org_fingerprint_idx" ON "local_installations" USING btree ("organization_id","machine_fingerprint_hash");
