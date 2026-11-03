-- Preview deploys of this branch applied this migration as 0053 before billing took
-- that number, so some databases already have these objects. Create them only when
-- they are missing.
DO $$
BEGIN
  IF to_regclass('public.access_requests') IS NULL THEN
    BEGIN
      CREATE TYPE "public"."access_request_status" AS ENUM('pending', 'approved', 'denied', 'cancelled');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      CREATE TYPE "public"."access_request_via" AS ENUM('page', 'cli');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    CREATE TABLE "access_requests" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"organization_id" uuid NOT NULL,
    	"project_id" uuid NOT NULL,
    	"page_site_id" uuid NOT NULL,
    	"route_id" uuid,
    	"path" text NOT NULL,
    	"requester_user_id" uuid NOT NULL,
    	"message" text,
    	"via" "access_request_via" NOT NULL,
    	"requester_organization_id" uuid,
    	"local_installation_id" uuid,
    	"agent_id" text,
    	"agent_name" text,
    	"status" "access_request_status" DEFAULT 'pending' NOT NULL,
    	"expires_at" timestamp with time zone NOT NULL,
    	"decided_by_user_id" uuid,
    	"decided_at" timestamp with time zone,
    	"grant_id" uuid,
    	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_page_site_id_page_sites_id_fk" FOREIGN KEY ("page_site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requester_organization_id_organizations_id_fk" FOREIGN KEY ("requester_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_grant_id_access_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grants"("id") ON DELETE set null ON UPDATE no action;
    CREATE UNIQUE INDEX "access_requests_pending_unique" ON "access_requests" USING btree ("page_site_id","path","requester_user_id") WHERE "access_requests"."status" = 'pending';
    CREATE INDEX "access_requests_site_status_idx" ON "access_requests" USING btree ("page_site_id","status");
    CREATE INDEX "access_requests_requester_idx" ON "access_requests" USING btree ("requester_user_id","created_at");
  END IF;
END $$;
