CREATE TYPE "public"."bug_report_priority" AS ENUM('p0', 'p1', 'p2', 'p3');--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "priority" "bug_report_priority";--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "priority_score" integer;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "duplicate_of_id" uuid;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "assignee_user_id" uuid;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "triage_json" jsonb;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD COLUMN "last_triage_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_duplicate_of_id_bug_reports_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."bug_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bug_reports_priority_idx" ON "bug_reports" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "bug_reports_assignee_user_id_idx" ON "bug_reports" USING btree ("assignee_user_id");--> statement-breakpoint
CREATE INDEX "bug_reports_duplicate_of_id_idx" ON "bug_reports" USING btree ("duplicate_of_id");--> statement-breakpoint
CREATE INDEX "bug_reports_status_priority_score_idx" ON "bug_reports" USING btree ("status","priority_score");