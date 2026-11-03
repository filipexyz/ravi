CREATE TABLE "page_comment_read_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"path" text NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_comment_created_at" timestamp with time zone,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_comment_read_receipts" ADD CONSTRAINT "page_comment_read_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comment_read_receipts" ADD CONSTRAINT "page_comment_read_receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comment_read_receipts" ADD CONSTRAINT "page_comment_read_receipts_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comment_read_receipts" ADD CONSTRAINT "page_comment_read_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_comment_read_receipts_site_path_user_unique" ON "page_comment_read_receipts" USING btree ("site_id","path","user_id");--> statement-breakpoint
CREATE INDEX "page_comment_read_receipts_org_idx" ON "page_comment_read_receipts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "page_comment_read_receipts_project_idx" ON "page_comment_read_receipts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_comment_read_receipts_user_idx" ON "page_comment_read_receipts" USING btree ("user_id");