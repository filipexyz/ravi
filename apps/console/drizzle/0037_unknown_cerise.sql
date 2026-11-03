CREATE TYPE "public"."page_password_policy_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."page_visibility" AS ENUM('public', 'private', 'protected_link', 'password');--> statement-breakpoint
CREATE TABLE "page_password_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"route_id" uuid,
	"password_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "page_password_policy_status" DEFAULT 'active' NOT NULL,
	"configured_by_user_id" uuid,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_password_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_token_hash" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"route_id" uuid,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"status" "pages_session_status" DEFAULT 'active' NOT NULL,
	"issued_for_host" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_release_routes" ALTER COLUMN "visibility" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "page_release_routes" ALTER COLUMN "visibility" SET DATA TYPE "public"."page_visibility" USING "visibility"::text::"public"."page_visibility";--> statement-breakpoint
ALTER TABLE "page_release_routes" ALTER COLUMN "visibility" SET DEFAULT 'private';--> statement-breakpoint
ALTER TABLE "page_routes" ALTER COLUMN "default_visibility" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "page_routes" ALTER COLUMN "default_visibility" SET DATA TYPE "public"."page_visibility" USING "default_visibility"::text::"public"."page_visibility";--> statement-breakpoint
ALTER TABLE "page_routes" ALTER COLUMN "default_visibility" SET DEFAULT 'private';--> statement-breakpoint
ALTER TABLE "page_routes" ALTER COLUMN "visibility" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "page_routes" ALTER COLUMN "visibility" SET DATA TYPE "public"."page_visibility" USING "visibility"::text::"public"."page_visibility";--> statement-breakpoint
ALTER TABLE "page_routes" ALTER COLUMN "visibility" SET DEFAULT 'private';--> statement-breakpoint
ALTER TABLE "page_sites" ALTER COLUMN "default_visibility" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "page_sites" ALTER COLUMN "default_visibility" SET DATA TYPE "public"."page_visibility" USING "default_visibility"::text::"public"."page_visibility";--> statement-breakpoint
ALTER TABLE "page_sites" ALTER COLUMN "default_visibility" SET DEFAULT 'private';--> statement-breakpoint
ALTER TABLE "page_password_policies" ADD CONSTRAINT "page_password_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_policies" ADD CONSTRAINT "page_password_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_policies" ADD CONSTRAINT "page_password_policies_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_policies" ADD CONSTRAINT "page_password_policies_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_policies" ADD CONSTRAINT "page_password_policies_configured_by_user_id_users_id_fk" FOREIGN KEY ("configured_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_sessions" ADD CONSTRAINT "page_password_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_sessions" ADD CONSTRAINT "page_password_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_sessions" ADD CONSTRAINT "page_password_sessions_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_sessions" ADD CONSTRAINT "page_password_sessions_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_password_sessions" ADD CONSTRAINT "page_password_sessions_policy_id_page_password_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."page_password_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_password_policies_site_default_unique" ON "page_password_policies" USING btree ("site_id") WHERE "page_password_policies"."route_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "page_password_policies_route_unique" ON "page_password_policies" USING btree ("route_id") WHERE "page_password_policies"."route_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "page_password_policies_org_idx" ON "page_password_policies" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_password_policies_project_idx" ON "page_password_policies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_password_policies_site_idx" ON "page_password_policies" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "page_password_policies_status_idx" ON "page_password_policies" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "page_password_sessions_token_hash_unique" ON "page_password_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "page_password_sessions_org_idx" ON "page_password_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_password_sessions_project_idx" ON "page_password_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_password_sessions_site_idx" ON "page_password_sessions" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "page_password_sessions_policy_idx" ON "page_password_sessions" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "page_password_sessions_status_idx" ON "page_password_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "page_password_sessions_expires_at_idx" ON "page_password_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "page_password_sessions_host_idx" ON "page_password_sessions" USING btree ("issued_for_host");