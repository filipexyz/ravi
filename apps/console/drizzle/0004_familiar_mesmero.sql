CREATE TYPE "public"."pages_claim_code_status" AS ENUM('active', 'consumed', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."pages_session_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TABLE "pages_claim_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"route_id" uuid,
	"artifact_id" uuid,
	"artifact_version_id" uuid,
	"user_id" uuid NOT NULL,
	"return_url" text NOT NULL,
	"requested_host" text NOT NULL,
	"requested_path" text NOT NULL,
	"status" "pages_claim_code_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_request_id" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_token_hash" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"site_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "pages_session_status" DEFAULT 'active' NOT NULL,
	"issued_for_host" text NOT NULL,
	"issued_from_claim_code_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_request_id" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages_claim_codes" ADD CONSTRAINT "pages_claim_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_claim_codes" ADD CONSTRAINT "pages_claim_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_claim_codes" ADD CONSTRAINT "pages_claim_codes_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_claim_codes" ADD CONSTRAINT "pages_claim_codes_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_claim_codes" ADD CONSTRAINT "pages_claim_codes_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_claim_codes" ADD CONSTRAINT "pages_claim_codes_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_claim_codes" ADD CONSTRAINT "pages_claim_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_sessions" ADD CONSTRAINT "pages_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_sessions" ADD CONSTRAINT "pages_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_sessions" ADD CONSTRAINT "pages_sessions_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_sessions" ADD CONSTRAINT "pages_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages_sessions" ADD CONSTRAINT "pages_sessions_issued_from_claim_code_id_pages_claim_codes_id_fk" FOREIGN KEY ("issued_from_claim_code_id") REFERENCES "public"."pages_claim_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_claim_codes_hash_unique" ON "pages_claim_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "pages_claim_codes_org_idx" ON "pages_claim_codes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "pages_claim_codes_project_idx" ON "pages_claim_codes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pages_claim_codes_site_idx" ON "pages_claim_codes" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "pages_claim_codes_user_idx" ON "pages_claim_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pages_claim_codes_status_idx" ON "pages_claim_codes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pages_claim_codes_expires_at_idx" ON "pages_claim_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_sessions_token_hash_unique" ON "pages_sessions" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "pages_sessions_org_idx" ON "pages_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "pages_sessions_project_idx" ON "pages_sessions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pages_sessions_site_idx" ON "pages_sessions" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "pages_sessions_user_idx" ON "pages_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pages_sessions_status_idx" ON "pages_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pages_sessions_expires_at_idx" ON "pages_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pages_sessions_host_idx" ON "pages_sessions" USING btree ("issued_for_host");