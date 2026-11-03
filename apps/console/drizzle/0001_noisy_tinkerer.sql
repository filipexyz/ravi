CREATE TYPE "public"."cli_session_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."local_installation_status" AS ENUM('active', 'revoked');--> statement-breakpoint
ALTER TYPE "public"."actor_type" ADD VALUE 'cli' BEFORE 'system';--> statement-breakpoint
CREATE TABLE "cli_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_installation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"previous_refresh_token_hash" text,
	"access_token_jti" text NOT NULL,
	"scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "cli_session_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"platform" text,
	"machine_fingerprint_hash" text,
	"ravi_version" text,
	"status" "local_installation_status" DEFAULT 'active' NOT NULL,
	"capabilities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_installations" ADD CONSTRAINT "local_installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_installations" ADD CONSTRAINT "local_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_sessions_refresh_hash_unique" ON "cli_sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_sessions_access_jti_unique" ON "cli_sessions" USING btree ("access_token_jti");--> statement-breakpoint
CREATE INDEX "cli_sessions_previous_refresh_hash_idx" ON "cli_sessions" USING btree ("previous_refresh_token_hash");--> statement-breakpoint
CREATE INDEX "cli_sessions_installation_idx" ON "cli_sessions" USING btree ("local_installation_id");--> statement-breakpoint
CREATE INDEX "cli_sessions_org_idx" ON "cli_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "cli_sessions_user_idx" ON "cli_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cli_sessions_status_idx" ON "cli_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cli_sessions_expires_at_idx" ON "cli_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "local_installations_fingerprint_unique" ON "local_installations" USING btree ("organization_id","user_id","machine_fingerprint_hash");--> statement-breakpoint
CREATE INDEX "local_installations_org_idx" ON "local_installations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "local_installations_user_idx" ON "local_installations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "local_installations_status_idx" ON "local_installations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "local_installations_last_seen_idx" ON "local_installations" USING btree ("last_seen_at");