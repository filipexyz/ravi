CREATE TABLE "bug_report_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bug_report_id" uuid NOT NULL,
	"local_installation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_report_subscriptions" ADD CONSTRAINT "bug_report_subscriptions_bug_report_id_bug_reports_id_fk" FOREIGN KEY ("bug_report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report_subscriptions" ADD CONSTRAINT "bug_report_subscriptions_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report_subscriptions" ADD CONSTRAINT "bug_report_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report_subscriptions" ADD CONSTRAINT "bug_report_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report_subscriptions" ADD CONSTRAINT "bug_report_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bug_report_subscriptions_bug_installation_unique" ON "bug_report_subscriptions" USING btree ("bug_report_id","local_installation_id");--> statement-breakpoint
CREATE INDEX "bug_report_subscriptions_bug_report_id_idx" ON "bug_report_subscriptions" USING btree ("bug_report_id");--> statement-breakpoint
CREATE INDEX "bug_report_subscriptions_installation_idx" ON "bug_report_subscriptions" USING btree ("local_installation_id");--> statement-breakpoint
CREATE INDEX "bug_report_subscriptions_user_id_idx" ON "bug_report_subscriptions" USING btree ("user_id");
