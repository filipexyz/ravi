CREATE TYPE "public"."cli_device_authorization_status" AS ENUM('pending', 'approved', 'consumed', 'expired', 'denied');--> statement-breakpoint
CREATE TABLE "cli_device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"status" "cli_device_authorization_status" DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"membership_id" uuid,
	"scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cli_device_authorizations" ADD CONSTRAINT "cli_device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_device_authorizations" ADD CONSTRAINT "cli_device_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_device_authorizations" ADD CONSTRAINT "cli_device_authorizations_membership_id_organization_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."organization_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_device_authorizations_device_hash_unique" ON "cli_device_authorizations" USING btree ("device_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_device_authorizations_user_hash_unique" ON "cli_device_authorizations" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "cli_device_authorizations_status_idx" ON "cli_device_authorizations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cli_device_authorizations_expires_idx" ON "cli_device_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cli_device_authorizations_user_idx" ON "cli_device_authorizations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cli_device_authorizations_org_idx" ON "cli_device_authorizations" USING btree ("organization_id");