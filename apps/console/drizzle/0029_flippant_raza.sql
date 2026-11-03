CREATE TYPE "public"."page_capture_image_role" AS ENUM('thumbnail', 'full_page', 'segment');--> statement-breakpoint
CREATE TYPE "public"."page_capture_mode" AS ENUM('thumbnail', 'full_page', 'segmented');--> statement-breakpoint
CREATE TYPE "public"."page_capture_status" AS ENUM('pending', 'capturing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "page_capture_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capture_set_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" "page_capture_image_role" NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"clip_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_capture_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"release_route_id" uuid NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"source_artifact_version_id" uuid NOT NULL,
	"capture_artifact_id" uuid,
	"capture_artifact_version_id" uuid,
	"mode" "page_capture_mode" DEFAULT 'thumbnail' NOT NULL,
	"status" "page_capture_status" DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'cloudflare_browser_run' NOT NULL,
	"config_hash" text NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"requested_by_actor_id" text,
	"failure_code" text,
	"failure_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_capture_images" ADD CONSTRAINT "page_capture_images_capture_set_id_page_capture_sets_id_fk" FOREIGN KEY ("capture_set_id") REFERENCES "public"."page_capture_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_images" ADD CONSTRAINT "page_capture_images_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_release_id_page_site_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."page_site_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_release_route_id_page_release_routes_id_fk" FOREIGN KEY ("release_route_id") REFERENCES "public"."page_release_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_source_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("source_artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_capture_artifact_id_artifacts_id_fk" FOREIGN KEY ("capture_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_capture_sets" ADD CONSTRAINT "page_capture_sets_capture_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("capture_artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_capture_images_set_sequence_unique" ON "page_capture_images" USING btree ("capture_set_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "page_capture_images_asset_unique" ON "page_capture_images" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "page_capture_images_set_idx" ON "page_capture_images" USING btree ("capture_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_capture_sets_project_idempotency_unique" ON "page_capture_sets" USING btree ("organization_id","project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "page_capture_sets_project_idx" ON "page_capture_sets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_capture_sets_site_route_idx" ON "page_capture_sets" USING btree ("site_id","route_id");--> statement-breakpoint
CREATE INDEX "page_capture_sets_source_version_idx" ON "page_capture_sets" USING btree ("source_artifact_version_id");--> statement-breakpoint
CREATE INDEX "page_capture_sets_status_created_at_idx" ON "page_capture_sets" USING btree ("status","created_at");