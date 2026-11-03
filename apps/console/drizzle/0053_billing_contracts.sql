CREATE TYPE "public"."billing_contract_item_kind" AS ENUM('fixed', 'metered');--> statement-breakpoint
CREATE TYPE "public"."billing_contract_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."billing_invoice_status" AS ENUM('draft', 'issued', 'paid', 'overdue', 'canceled', 'refunded');--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "address_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "profile_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "profile_updated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN "billable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN "billable_note" text;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN "billable_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "local_installations" ADD COLUMN "billable_marked_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_contract_items" ADD CONSTRAINT "billing_contract_items_contract_id_billing_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."billing_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_contracts" ADD CONSTRAINT "billing_contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_contracts" ADD CONSTRAINT "billing_contracts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_contract_item_id_billing_contract_items_id_fk" FOREIGN KEY ("contract_item_id") REFERENCES "public"."billing_contract_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoice_lines" ADD CONSTRAINT "billing_invoice_lines_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_contract_id_billing_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."billing_contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_prepared_by_user_id_users_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_provider_events" ADD CONSTRAINT "billing_provider_events_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_contract_items_contract_idx" ON "billing_contract_items" USING btree ("contract_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_contracts_org_version_unique" ON "billing_contracts" USING btree ("organization_id","version");--> statement-breakpoint
CREATE INDEX "billing_contracts_org_period_idx" ON "billing_contracts" USING btree ("organization_id","starts_period");--> statement-breakpoint
CREATE INDEX "billing_invoice_lines_invoice_idx" ON "billing_invoice_lines" USING btree ("invoice_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_org_period_open_unique" ON "billing_invoices" USING btree ("organization_id","period") WHERE "billing_invoices"."status" <> 'canceled';--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_provider_payment_unique" ON "billing_invoices" USING btree ("provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_org_idx" ON "billing_invoices" USING btree ("organization_id","period");--> statement-breakpoint
CREATE INDEX "billing_invoices_status_idx" ON "billing_invoices" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_provider_events_event_unique" ON "billing_provider_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "billing_provider_events_payment_idx" ON "billing_provider_events" USING btree ("provider","provider_payment_id");--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_profile_updated_by_user_id_users_id_fk" FOREIGN KEY ("profile_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_installations" ADD CONSTRAINT "local_installations_billable_marked_by_user_id_users_id_fk" FOREIGN KEY ("billable_marked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_installations_billable_idx" ON "local_installations" USING btree ("organization_id","billable");