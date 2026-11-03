-- 0052 is older than 0053_billing_contracts, which preview deploys of the billing
-- branch applied first; the migrator then skips 0052 on those databases. Create
-- its objects here when they are missing. A database that ran 0052 skips this.
DO $$
BEGIN
  IF to_regclass('public.organization_invites') IS NULL THEN
    CREATE TYPE "public"."access_object_type" AS ENUM('page_site', 'page_route');
    CREATE TYPE "public"."access_relation" AS ENUM('viewer');
    CREATE TYPE "public"."access_subject_type" AS ENUM('user');
    CREATE TYPE "public"."organization_invite_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');
    CREATE TABLE "access_grants" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"organization_id" uuid NOT NULL,
    	"project_id" uuid NOT NULL,
    	"page_site_id" uuid NOT NULL,
    	"object_type" "access_object_type" NOT NULL,
    	"object_id" uuid NOT NULL,
    	"relation" "access_relation" DEFAULT 'viewer' NOT NULL,
    	"subject_type" "access_subject_type" DEFAULT 'user' NOT NULL,
    	"subject_id" uuid NOT NULL,
    	"reason" text,
    	"expires_at" timestamp with time zone,
    	"created_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
    	"created_by_actor_id" text,
    	"revoked_at" timestamp with time zone,
    	"revoked_by_actor_type" "actor_type",
    	"revoked_by_actor_id" text,
    	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "organization_invites" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"organization_id" uuid NOT NULL,
    	"email" text NOT NULL,
    	"role" "organization_role" DEFAULT 'viewer' NOT NULL,
    	"token_hash" text NOT NULL,
    	"status" "organization_invite_status" DEFAULT 'pending' NOT NULL,
    	"invited_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
    	"invited_by_user_id" uuid,
    	"expires_at" timestamp with time zone NOT NULL,
    	"accepted_by_user_id" uuid,
    	"accepted_at" timestamp with time zone,
    	"revoked_at" timestamp with time zone,
    	"revoked_by_user_id" uuid,
    	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_page_site_id_page_sites_id_fk" FOREIGN KEY ("page_site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    CREATE UNIQUE INDEX "access_grants_tuple_active_unique" ON "access_grants" USING btree ("object_type","object_id","relation","subject_type","subject_id") WHERE "access_grants"."revoked_at" IS NULL;
    CREATE INDEX "access_grants_subject_idx" ON "access_grants" USING btree ("subject_type","subject_id");
    CREATE INDEX "access_grants_site_idx" ON "access_grants" USING btree ("page_site_id");
    CREATE INDEX "access_grants_org_idx" ON "access_grants" USING btree ("organization_id");
    CREATE UNIQUE INDEX "organization_invites_token_hash_unique" ON "organization_invites" USING btree ("token_hash");
    CREATE UNIQUE INDEX "organization_invites_org_email_pending_unique" ON "organization_invites" USING btree ("organization_id","email") WHERE "organization_invites"."status" = 'pending';
    CREATE INDEX "organization_invites_org_status_idx" ON "organization_invites" USING btree ("organization_id","status");
  END IF;
END $$;
