CREATE TYPE "public"."ravi_link_request_status" AS ENUM('pending', 'approved', 'denied', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "ravi_link_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"cli_session_id" uuid,
	"contact_id" text NOT NULL,
	"platform_identities_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requester_display_name" text,
	"expected_email_hash" text,
	"status" "ravi_link_request_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"binding_id" uuid,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ravi_link_requests" ADD CONSTRAINT "ravi_link_requests_installation_id_local_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_link_requests" ADD CONSTRAINT "ravi_link_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_link_requests" ADD CONSTRAINT "ravi_link_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_link_requests" ADD CONSTRAINT "ravi_link_requests_cli_session_id_cli_sessions_id_fk" FOREIGN KEY ("cli_session_id") REFERENCES "public"."cli_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_link_requests" ADD CONSTRAINT "ravi_link_requests_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ravi_link_requests" ADD CONSTRAINT "ravi_link_requests_binding_id_ravi_actor_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."ravi_actor_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ravi_link_requests_token_hash_unique" ON "ravi_link_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ravi_link_requests_installation_contact_pending_unique" ON "ravi_link_requests" USING btree ("installation_id","contact_id") WHERE "ravi_link_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ravi_link_requests_installation_status_idx" ON "ravi_link_requests" USING btree ("installation_id","status");--> statement-breakpoint
CREATE INDEX "ravi_link_requests_expires_idx" ON "ravi_link_requests" USING btree ("expires_at");