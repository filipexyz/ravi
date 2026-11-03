CREATE TYPE "public"."page_comment_status" AS ENUM('open', 'resolved', 'deleted');--> statement-breakpoint
CREATE TABLE "page_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"route_id" uuid,
	"release_id" uuid,
	"release_route_id" uuid,
	"artifact_id" uuid,
	"artifact_version_id" uuid,
	"path" text NOT NULL,
	"body" text NOT NULL,
	"target_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "page_comment_status" DEFAULT 'open' NOT NULL,
	"created_by_user_id" uuid,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_release_id_page_site_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."page_site_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_release_route_id_page_release_routes_id_fk" FOREIGN KEY ("release_route_id") REFERENCES "public"."page_release_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_comments_org_idx" ON "page_comments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_comments_project_idx" ON "page_comments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_comments_site_path_idx" ON "page_comments" USING btree ("site_id","path");--> statement-breakpoint
CREATE INDEX "page_comments_route_idx" ON "page_comments" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "page_comments_release_idx" ON "page_comments" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "page_comments_author_idx" ON "page_comments" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "page_comments_status_created_at_idx" ON "page_comments" USING btree ("status","created_at");