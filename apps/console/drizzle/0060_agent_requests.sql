CREATE TABLE IF NOT EXISTS "agent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"from_installation_id" uuid,
	"from_agent_id" text,
	"from_user_id" uuid,
	"to_installation_id" uuid NOT NULL,
	"to_agent_id" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reply" text,
	"failure_reason" text,
	"delivered_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"reply_delivered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installation_agents" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "installation_agents" ADD COLUMN IF NOT EXISTS "accepts_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_from_installation_id_local_installations_id_fk" FOREIGN KEY ("from_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_requests" ADD CONSTRAINT "agent_requests_to_installation_id_local_installations_id_fk" FOREIGN KEY ("to_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_requests_to_status_idx" ON "agent_requests" USING btree ("to_installation_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_requests_from_status_idx" ON "agent_requests" USING btree ("from_installation_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_requests_org_idx" ON "agent_requests" USING btree ("organization_id");