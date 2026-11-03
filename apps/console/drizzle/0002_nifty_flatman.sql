CREATE TYPE "public"."page_publish_status" AS ENUM('started', 'uploading', 'validating', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."page_route_match_type" AS ENUM('exact', 'prefix', 'spa');--> statement-breakpoint
CREATE TYPE "public"."page_route_status" AS ENUM('active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."page_site_release_status" AS ENUM('draft', 'active', 'archived', 'failed');--> statement-breakpoint
CREATE TYPE "public"."page_site_status" AS ENUM('active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."page_upload_session_status" AS ENUM('created', 'uploading', 'uploaded', 'finalized', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "page_publishes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"artifact_id" uuid,
	"artifact_version_id" uuid,
	"site_id" uuid,
	"site_release_id" uuid,
	"source_type" text NOT NULL,
	"source_ref" text,
	"status" "page_publish_status" DEFAULT 'started' NOT NULL,
	"manifest_key" text,
	"manifest_hash" text,
	"object_count" integer,
	"total_bytes" bigint,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"route_changes_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"error_code" text,
	"created_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"created_by_actor_id" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_release_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"path" text NOT NULL,
	"match_type" "page_route_match_type" NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"artifact_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"entrypoint" text DEFAULT 'index.html' NOT NULL,
	"asset_base" text NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"route_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"path" text NOT NULL,
	"match_type" "page_route_match_type" NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"default_visibility" "visibility" DEFAULT 'private' NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"status" "page_route_status" DEFAULT 'active' NOT NULL,
	"route_config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_site_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"release_number" integer NOT NULL,
	"previous_release_id" uuid,
	"status" "page_site_release_status" DEFAULT 'draft' NOT NULL,
	"reason" text,
	"manifest_hash" text,
	"created_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"created_by_actor_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"default_hostname" text NOT NULL,
	"default_visibility" "visibility" DEFAULT 'private' NOT NULL,
	"active_release_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "page_site_status" DEFAULT 'active' NOT NULL,
	"created_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"created_by_actor_id" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid,
	"status" "page_upload_session_status" DEFAULT 'created' NOT NULL,
	"staging_prefix" text NOT NULL,
	"idempotency_key" text,
	"file_manifest_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"upload_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"created_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"created_by_actor_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_publishes" ADD CONSTRAINT "page_publishes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_publishes" ADD CONSTRAINT "page_publishes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_publishes" ADD CONSTRAINT "page_publishes_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_publishes" ADD CONSTRAINT "page_publishes_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_publishes" ADD CONSTRAINT "page_publishes_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_publishes" ADD CONSTRAINT "page_publishes_site_release_id_page_site_releases_id_fk" FOREIGN KEY ("site_release_id") REFERENCES "public"."page_site_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_release_routes" ADD CONSTRAINT "page_release_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_release_routes" ADD CONSTRAINT "page_release_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_release_routes" ADD CONSTRAINT "page_release_routes_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_release_routes" ADD CONSTRAINT "page_release_routes_release_id_page_site_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."page_site_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_release_routes" ADD CONSTRAINT "page_release_routes_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_release_routes" ADD CONSTRAINT "page_release_routes_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_release_routes" ADD CONSTRAINT "page_release_routes_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_routes" ADD CONSTRAINT "page_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_routes" ADD CONSTRAINT "page_routes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_routes" ADD CONSTRAINT "page_routes_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_site_releases" ADD CONSTRAINT "page_site_releases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_site_releases" ADD CONSTRAINT "page_site_releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_site_releases" ADD CONSTRAINT "page_site_releases_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_sites" ADD CONSTRAINT "page_sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_sites" ADD CONSTRAINT "page_sites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_upload_sessions" ADD CONSTRAINT "page_upload_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_upload_sessions" ADD CONSTRAINT "page_upload_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_upload_sessions" ADD CONSTRAINT "page_upload_sessions_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_publishes_idempotency_unique" ON "page_publishes" USING btree ("organization_id","project_id","created_by_actor_type","created_by_actor_id","idempotency_key") WHERE "page_publishes"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "page_publishes_org_idx" ON "page_publishes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_publishes_project_idx" ON "page_publishes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_publishes_site_idx" ON "page_publishes" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "page_publishes_status_idx" ON "page_publishes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "page_publishes_created_at_idx" ON "page_publishes" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "page_release_routes_release_route_unique" ON "page_release_routes" USING btree ("release_id","route_id");--> statement-breakpoint
CREATE INDEX "page_release_routes_release_idx" ON "page_release_routes" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "page_release_routes_site_idx" ON "page_release_routes" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "page_release_routes_artifact_version_idx" ON "page_release_routes" USING btree ("artifact_version_id");--> statement-breakpoint
CREATE INDEX "page_release_routes_match_idx" ON "page_release_routes" USING btree ("release_id","match_type","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "page_routes_site_path_match_unique" ON "page_routes" USING btree ("site_id","path","match_type");--> statement-breakpoint
CREATE INDEX "page_routes_org_idx" ON "page_routes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_routes_project_idx" ON "page_routes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_routes_site_idx" ON "page_routes" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "page_routes_match_idx" ON "page_routes" USING btree ("site_id","match_type","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "page_site_releases_site_number_unique" ON "page_site_releases" USING btree ("site_id","release_number");--> statement-breakpoint
CREATE INDEX "page_site_releases_org_idx" ON "page_site_releases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_site_releases_project_idx" ON "page_site_releases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_site_releases_site_idx" ON "page_site_releases" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "page_site_releases_status_idx" ON "page_site_releases" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "page_sites_slug_unique" ON "page_sites" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "page_sites_default_hostname_unique" ON "page_sites" USING btree ("default_hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "page_sites_project_default_unique" ON "page_sites" USING btree ("project_id") WHERE "page_sites"."is_default" = true;--> statement-breakpoint
CREATE INDEX "page_sites_org_idx" ON "page_sites" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_sites_project_idx" ON "page_sites" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_sites_status_idx" ON "page_sites" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "page_upload_sessions_idempotency_unique" ON "page_upload_sessions" USING btree ("organization_id","project_id","created_by_actor_type","created_by_actor_id","idempotency_key") WHERE "page_upload_sessions"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "page_upload_sessions_org_idx" ON "page_upload_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_upload_sessions_project_idx" ON "page_upload_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_upload_sessions_site_idx" ON "page_upload_sessions" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "page_upload_sessions_status_idx" ON "page_upload_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "page_upload_sessions_expires_at_idx" ON "page_upload_sessions" USING btree ("expires_at");