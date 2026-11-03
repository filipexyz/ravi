CREATE TYPE "public"."domain_binding_product" AS ENUM('pages', 'mail');--> statement-breakpoint
CREATE TYPE "public"."domain_binding_status" AS ENUM('pending', 'active', 'disabled', 'deleted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."domain_claim_status" AS ENUM('pending', 'active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."domain_ownership_mode" AS ENUM('ravi_managed', 'customer_managed');--> statement-breakpoint
CREATE TYPE "public"."domain_verification_status" AS ENUM('pending', 'verified', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "domain_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain_claim_id" uuid NOT NULL,
	"product" "domain_binding_product" NOT NULL,
	"hostname" text NOT NULL,
	"status" "domain_binding_status" DEFAULT 'pending' NOT NULL,
	"readiness_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"normalized_domain" text NOT NULL,
	"display_domain" text NOT NULL,
	"ownership_mode" "domain_ownership_mode" DEFAULT 'customer_managed' NOT NULL,
	"status" "domain_claim_status" DEFAULT 'pending' NOT NULL,
	"verification_status" "domain_verification_status" DEFAULT 'pending' NOT NULL,
	"verification_method" text DEFAULT 'dns_txt' NOT NULL,
	"verification_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"created_by_actor_id" text,
	"verified_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_domain_bindings" (
	"domain_binding_id" uuid PRIMARY KEY NOT NULL,
	"mail_domain_id" uuid NOT NULL,
	"inbound_readiness_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outbound_readiness_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"catch_all_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_domain_bindings" (
	"domain_binding_id" uuid PRIMARY KEY NOT NULL,
	"page_site_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"edge_readiness_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "domain_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "domain_bindings" ADD CONSTRAINT "domain_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_bindings" ADD CONSTRAINT "domain_bindings_domain_claim_id_domain_claims_id_fk" FOREIGN KEY ("domain_claim_id") REFERENCES "public"."domain_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_claims" ADD CONSTRAINT "domain_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domain_bindings" ADD CONSTRAINT "mail_domain_bindings_domain_binding_id_domain_bindings_id_fk" FOREIGN KEY ("domain_binding_id") REFERENCES "public"."domain_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domain_bindings" ADD CONSTRAINT "mail_domain_bindings_mail_domain_id_mail_domains_id_fk" FOREIGN KEY ("mail_domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_domain_bindings" ADD CONSTRAINT "page_domain_bindings_domain_binding_id_domain_bindings_id_fk" FOREIGN KEY ("domain_binding_id") REFERENCES "public"."domain_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_domain_bindings" ADD CONSTRAINT "page_domain_bindings_page_site_id_page_sites_id_fk" FOREIGN KEY ("page_site_id") REFERENCES "public"."page_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_bindings_product_hostname_active_unique" ON "domain_bindings" USING btree ("product","hostname") WHERE "domain_bindings"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "domain_bindings_org_idx" ON "domain_bindings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "domain_bindings_claim_idx" ON "domain_bindings" USING btree ("domain_claim_id");--> statement-breakpoint
CREATE INDEX "domain_bindings_product_idx" ON "domain_bindings" USING btree ("product");--> statement-breakpoint
CREATE INDEX "domain_bindings_status_idx" ON "domain_bindings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_claims_normalized_active_unique" ON "domain_claims" USING btree ("normalized_domain") WHERE "domain_claims"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "domain_claims_org_idx" ON "domain_claims" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "domain_claims_status_idx" ON "domain_claims" USING btree ("status");--> statement-breakpoint
CREATE INDEX "domain_claims_verification_idx" ON "domain_claims" USING btree ("verification_status");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_domain_bindings_mail_domain_unique" ON "mail_domain_bindings" USING btree ("mail_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_domain_bindings_hostname_unique" ON "page_domain_bindings" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "page_domain_bindings_site_idx" ON "page_domain_bindings" USING btree ("page_site_id");--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_domain_claim_id_domain_claims_id_fk" FOREIGN KEY ("domain_claim_id") REFERENCES "public"."domain_claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_domains_domain_claim_idx" ON "mail_domains" USING btree ("domain_claim_id");