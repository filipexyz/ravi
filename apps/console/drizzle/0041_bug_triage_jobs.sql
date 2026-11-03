CREATE TYPE "public"."bug_triage_job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."bug_triage_job_trigger" AS ENUM('create', 'manual');--> statement-breakpoint
CREATE TABLE "bug_triage_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bug_report_id" uuid NOT NULL,
	"status" "bug_triage_job_status" DEFAULT 'queued' NOT NULL,
	"trigger" "bug_triage_job_trigger" NOT NULL,
	"request_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_triage_jobs" ADD CONSTRAINT "bug_triage_jobs_bug_report_id_bug_reports_id_fk" FOREIGN KEY ("bug_report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bug_triage_jobs_active_unique" ON "bug_triage_jobs" USING btree ("bug_report_id") WHERE "bug_triage_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "bug_triage_jobs_status_created_idx" ON "bug_triage_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "bug_triage_jobs_bug_report_id_idx" ON "bug_triage_jobs" USING btree ("bug_report_id");--> statement-breakpoint
CREATE INDEX "bug_triage_jobs_locked_until_idx" ON "bug_triage_jobs" USING btree ("locked_until");