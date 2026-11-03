CREATE TABLE "bug_report_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bug_report_id" uuid NOT NULL,
	"schema_version" text DEFAULT 'ravi.bug_comment/v1' NOT NULL,
	"author_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"text" text,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_report_comments" ADD CONSTRAINT "bug_report_comments_bug_report_id_bug_reports_id_fk" FOREIGN KEY ("bug_report_id") REFERENCES "public"."bug_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_report_comments" ADD CONSTRAINT "bug_report_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bug_report_comments_bug_idempotency_unique" ON "bug_report_comments" USING btree ("bug_report_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bug_report_comments_bug_report_id_idx" ON "bug_report_comments" USING btree ("bug_report_id");--> statement-breakpoint
CREATE INDEX "bug_report_comments_created_at_idx" ON "bug_report_comments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bug_report_comments_author_user_id_idx" ON "bug_report_comments" USING btree ("author_user_id");