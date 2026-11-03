CREATE TABLE "page_viewer_assertion_audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_viewer_assertion_audiences" ADD CONSTRAINT "page_viewer_assertion_audiences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_viewer_assertion_audiences" ADD CONSTRAINT "page_viewer_assertion_audiences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_viewer_assertion_audiences" ADD CONSTRAINT "page_viewer_assertion_audiences_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_viewer_assertion_audiences" ADD CONSTRAINT "page_viewer_assertion_audiences_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_viewer_assertion_audiences_site_audience_unique" ON "page_viewer_assertion_audiences" USING btree ("site_id","audience");--> statement-breakpoint
CREATE INDEX "page_viewer_assertion_audiences_org_idx" ON "page_viewer_assertion_audiences" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_viewer_assertion_audiences_project_idx" ON "page_viewer_assertion_audiences" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_viewer_assertion_audiences_site_idx" ON "page_viewer_assertion_audiences" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "page_viewer_assertion_audiences_status_idx" ON "page_viewer_assertion_audiences" USING btree ("status");