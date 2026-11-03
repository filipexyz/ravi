-- A database records only migrations newer than the newest one it has applied.
-- Preview deploys of other branches recorded newer timestamps on some databases,
-- so 0052_access_invites_grants or 0053_billing_contracts may have been skipped.
-- Create each one's objects here when they are missing; each ran in a single
-- transaction, so one table tells whether all of it is present.
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
  IF to_regclass('public.billing_contracts') IS NULL THEN
    CREATE TYPE "public"."billing_contract_item_kind" AS ENUM('fixed', 'metered');
    CREATE TYPE "public"."billing_contract_status" AS ENUM('active', 'ended');
    CREATE TYPE "public"."billing_invoice_status" AS ENUM('draft', 'issued', 'paid', 'overdue', 'canceled', 'refunded');
    CREATE TABLE "billing_contract_items" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"contract_id" uuid NOT NULL,
    	"position" integer NOT NULL,
    	"kind" "billing_contract_item_kind" NOT NULL,
    	"description" text NOT NULL,
    	"metric_key" text,
    	"quantity" numeric(20, 6),
    	"included_quantity" numeric(20, 6),
    	"cap_quantity" numeric(20, 6),
    	"unit" text DEFAULT 'unit' NOT NULL,
    	"unit_price_cents" bigint NOT NULL,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "billing_contracts" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"organization_id" uuid NOT NULL,
    	"version" integer NOT NULL,
    	"status" "billing_contract_status" DEFAULT 'active' NOT NULL,
    	"starts_period" text NOT NULL,
    	"ends_period" text,
    	"currency" text DEFAULT 'BRL' NOT NULL,
    	"due_day" integer DEFAULT 10 NOT NULL,
    	"notes" text,
    	"created_by_user_id" uuid,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "billing_invoice_lines" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"invoice_id" uuid NOT NULL,
    	"position" integer NOT NULL,
    	"source" text NOT NULL,
    	"contract_item_id" uuid,
    	"description" text NOT NULL,
    	"metric_key" text,
    	"quantity" numeric(20, 6) DEFAULT '1' NOT NULL,
    	"unit" text DEFAULT 'unit' NOT NULL,
    	"unit_price_cents" bigint NOT NULL,
    	"amount_cents" bigint NOT NULL,
    	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
    	"created_by_user_id" uuid,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "billing_invoices" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"organization_id" uuid NOT NULL,
    	"contract_id" uuid,
    	"period" text NOT NULL,
    	"status" "billing_invoice_status" DEFAULT 'draft' NOT NULL,
    	"currency" text DEFAULT 'BRL' NOT NULL,
    	"total_cents" bigint DEFAULT 0 NOT NULL,
    	"due_date" text,
    	"provider" text,
    	"provider_customer_id" text,
    	"provider_payment_id" text,
    	"provider_invoice_url" text,
    	"pix_copy_paste" text,
    	"boleto_line" text,
    	"prepared_at" timestamp with time zone,
    	"prepared_by_user_id" uuid,
    	"issued_at" timestamp with time zone,
    	"issued_by_user_id" uuid,
    	"paid_at" timestamp with time zone,
    	"canceled_at" timestamp with time zone,
    	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "billing_provider_events" (
    	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    	"provider" text NOT NULL,
    	"provider_event_id" text NOT NULL,
    	"event_type" text NOT NULL,
    	"provider_payment_id" text,
    	"invoice_id" uuid,
    	"outcome" text,
    	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
    	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
    	"processed_at" timestamp with time zone
    );
    ALTER TABLE "billing_accounts" ADD COLUMN "legal_name" text;
    ALTER TABLE "billing_accounts" ADD COLUMN "tax_id" text;
    ALTER TABLE "billing_accounts" ADD COLUMN "billing_email" text;
    ALTER TABLE "billing_accounts" ADD COLUMN "phone" text;
    ALTER TABLE "billing_accounts" ADD COLUMN "address_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
    ALTER TABLE "billing_accounts" ADD COLUMN "profile_updated_at" timestamp with time zone;
    ALTER TABLE "billing_accounts" ADD COLUMN "profile_updated_by_user_id" uuid;
    ALTER TABLE "local_installations" ADD COLUMN "billable" boolean DEFAULT false NOT NULL;
    ALTER TABLE "local_installations" ADD COLUMN "billable_note" text;
    ALTER TABLE "local_installations" ADD COLUMN "billable_marked_at" timestamp with time zone;
    ALTER TABLE "local_installations" ADD COLUMN "billable_marked_by_user_id" uuid;
    ALTER TABLE "billing_contract_items" ADD CONSTRAINT "billing_contract_items_contract_id_billing_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."billing_contracts"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "billing_contracts" ADD CONSTRAINT "billing_contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "billing_contracts" ADD CONSTRAINT "billing_contracts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_contract_item_id_billing_contract_items_id_fk" FOREIGN KEY ("contract_item_id") REFERENCES "public"."billing_contract_items"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_contract_id_billing_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."billing_contracts"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_prepared_by_user_id_users_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "billing_provider_events" ADD CONSTRAINT "billing_provider_events_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX "billing_contract_items_contract_idx" ON "billing_contract_items" USING btree ("contract_id","position");
    CREATE UNIQUE INDEX "billing_contracts_org_version_unique" ON "billing_contracts" USING btree ("organization_id","version");
    CREATE INDEX "billing_contracts_org_period_idx" ON "billing_contracts" USING btree ("organization_id","starts_period");
    CREATE INDEX "billing_invoice_lines_invoice_idx" ON "billing_invoice_lines" USING btree ("invoice_id","position");
    CREATE UNIQUE INDEX "billing_invoices_org_period_open_unique" ON "billing_invoices" USING btree ("organization_id","period") WHERE "billing_invoices"."status" <> 'canceled';
    CREATE UNIQUE INDEX "billing_invoices_provider_payment_unique" ON "billing_invoices" USING btree ("provider","provider_payment_id");
    CREATE INDEX "billing_invoices_org_idx" ON "billing_invoices" USING btree ("organization_id","period");
    CREATE INDEX "billing_invoices_status_idx" ON "billing_invoices" USING btree ("status");
    CREATE UNIQUE INDEX "billing_provider_events_event_unique" ON "billing_provider_events" USING btree ("provider","provider_event_id");
    CREATE INDEX "billing_provider_events_payment_idx" ON "billing_provider_events" USING btree ("provider","provider_payment_id");
    ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_profile_updated_by_user_id_users_id_fk" FOREIGN KEY ("profile_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "local_installations" ADD CONSTRAINT "local_installations_billable_marked_by_user_id_users_id_fk" FOREIGN KEY ("billable_marked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX "local_installations_billable_idx" ON "local_installations" USING btree ("organization_id","billable");
  END IF;
END $$;
