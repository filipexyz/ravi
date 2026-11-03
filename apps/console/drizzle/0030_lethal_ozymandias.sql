CREATE TYPE "public"."event_plane_cell_status" AS ENUM('provisioning', 'active', 'degraded', 'draining', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."event_plane_control_operation_status" AS ENUM('started', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."event_plane_credential_grant_status" AS ENUM('pending', 'issued', 'active', 'revoked', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."event_plane_cross_account_link_status" AS ENUM('proposed', 'active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."event_plane_cross_account_link_type" AS ENUM('export', 'import', 'service');--> statement-breakpoint
CREATE TYPE "public"."event_plane_identity_status" AS ENUM('provisioning', 'active', 'rotating', 'revoked', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."event_plane_identity_type" AS ENUM('control_service', 'managed_runtime', 'bridge', 'enterprise_client');--> statement-breakpoint
CREATE TYPE "public"."event_plane_org_binding_status" AS ENUM('provisioning', 'active', 'suspended', 'migrating', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."event_plane_policy_scope_type" AS ENUM('global', 'cell', 'organization', 'identity');--> statement-breakpoint
CREATE TYPE "public"."event_plane_policy_status" AS ENUM('draft', 'active', 'superseded', 'revoked');--> statement-breakpoint
CREATE TABLE "event_plane_cells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"environment" text NOT NULL,
	"region" text NOT NULL,
	"placement_class" text NOT NULL,
	"status" "event_plane_cell_status" DEFAULT 'provisioning' NOT NULL,
	"endpoint_ref" text,
	"system_account_ref" text,
	"resolver_ref" text,
	"capacity_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_capacity_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plane_control_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_key" text NOT NULL,
	"organization_id" uuid,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "event_plane_control_operation_status" DEFAULT 'started' NOT NULL,
	"target_type" text,
	"target_id" text,
	"response_json" jsonb,
	"error_code" text,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"request_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plane_credential_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"provider_user_public_key" text,
	"secret_ref" text,
	"status" "event_plane_credential_grant_status" DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"issued_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plane_cross_account_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"target_binding_id" uuid,
	"target_system_service" text,
	"link_type" "event_plane_cross_account_link_type" NOT NULL,
	"subject_pattern" text NOT NULL,
	"response_pattern" text,
	"status" "event_plane_cross_account_link_status" DEFAULT 'proposed' NOT NULL,
	"justification" text NOT NULL,
	"policy_version" integer NOT NULL,
	"approved_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plane_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"identity_type" "event_plane_identity_type" NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "event_plane_identity_status" DEFAULT 'provisioning' NOT NULL,
	"permissions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plane_org_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"provider_account_ref" text,
	"account_public_key" text,
	"status" "event_plane_org_binding_status" DEFAULT 'provisioning' NOT NULL,
	"placement_reason" text NOT NULL,
	"quota_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stream_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_policy_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"activated_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plane_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" "event_plane_policy_scope_type" NOT NULL,
	"scope_id" text NOT NULL,
	"version" integer NOT NULL,
	"policy_hash" text NOT NULL,
	"policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "event_plane_policy_status" DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_plane_control_operations" ADD CONSTRAINT "event_plane_control_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plane_credential_grants" ADD CONSTRAINT "event_plane_credential_grants_identity_id_event_plane_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."event_plane_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plane_cross_account_links" ADD CONSTRAINT "event_plane_cross_account_links_source_binding_id_event_plane_org_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."event_plane_org_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plane_cross_account_links" ADD CONSTRAINT "event_plane_cross_account_links_target_binding_id_event_plane_org_bindings_id_fk" FOREIGN KEY ("target_binding_id") REFERENCES "public"."event_plane_org_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plane_identities" ADD CONSTRAINT "event_plane_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plane_identities" ADD CONSTRAINT "event_plane_identities_binding_id_event_plane_org_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."event_plane_org_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plane_org_bindings" ADD CONSTRAINT "event_plane_org_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plane_org_bindings" ADD CONSTRAINT "event_plane_org_bindings_cell_id_event_plane_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."event_plane_cells"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_cells_provider_ref_unique" ON "event_plane_cells" USING btree ("provider","provider_ref") WHERE "event_plane_cells"."provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_plane_cells_env_region_status_idx" ON "event_plane_cells" USING btree ("environment","region","status");--> statement-breakpoint
CREATE INDEX "event_plane_cells_provider_idx" ON "event_plane_cells" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "event_plane_cells_heartbeat_idx" ON "event_plane_cells" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_control_operations_idempotency_unique" ON "event_plane_control_operations" USING btree ("scope_key","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "event_plane_control_operations_org_idx" ON "event_plane_control_operations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "event_plane_control_operations_status_idx" ON "event_plane_control_operations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "event_plane_control_operations_request_idx" ON "event_plane_control_operations" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "event_plane_control_operations_target_idx" ON "event_plane_control_operations" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "event_plane_control_operations_expires_idx" ON "event_plane_control_operations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_credential_grants_public_key_unique" ON "event_plane_credential_grants" USING btree ("provider_user_public_key") WHERE "event_plane_credential_grants"."provider_user_public_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_plane_credential_grants_identity_status_idx" ON "event_plane_credential_grants" USING btree ("identity_id","status");--> statement-breakpoint
CREATE INDEX "event_plane_credential_grants_expires_idx" ON "event_plane_credential_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "event_plane_cross_account_links_source_status_idx" ON "event_plane_cross_account_links" USING btree ("source_binding_id","status");--> statement-breakpoint
CREATE INDEX "event_plane_cross_account_links_target_idx" ON "event_plane_cross_account_links" USING btree ("target_binding_id");--> statement-breakpoint
CREATE INDEX "event_plane_cross_account_links_service_idx" ON "event_plane_cross_account_links" USING btree ("target_system_service");--> statement-breakpoint
CREATE INDEX "event_plane_cross_account_links_subject_idx" ON "event_plane_cross_account_links" USING btree ("subject_pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_identities_binding_principal_active_unique" ON "event_plane_identities" USING btree ("binding_id","identity_type","principal_type","principal_id") WHERE "event_plane_identities"."status" IN ('provisioning', 'active', 'rotating');--> statement-breakpoint
CREATE INDEX "event_plane_identities_org_status_idx" ON "event_plane_identities" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "event_plane_identities_binding_status_idx" ON "event_plane_identities" USING btree ("binding_id","status");--> statement-breakpoint
CREATE INDEX "event_plane_identities_principal_idx" ON "event_plane_identities" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_org_bindings_org_active_unique" ON "event_plane_org_bindings" USING btree ("organization_id") WHERE "event_plane_org_bindings"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_org_bindings_account_key_unique" ON "event_plane_org_bindings" USING btree ("account_public_key") WHERE "event_plane_org_bindings"."account_public_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_org_bindings_provider_account_unique" ON "event_plane_org_bindings" USING btree ("provider_account_ref") WHERE "event_plane_org_bindings"."provider_account_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_plane_org_bindings_org_status_idx" ON "event_plane_org_bindings" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "event_plane_org_bindings_cell_status_idx" ON "event_plane_org_bindings" USING btree ("cell_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_policy_versions_scope_version_unique" ON "event_plane_policy_versions" USING btree ("scope_type","scope_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "event_plane_policy_versions_scope_active_unique" ON "event_plane_policy_versions" USING btree ("scope_type","scope_id") WHERE "event_plane_policy_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "event_plane_policy_versions_hash_idx" ON "event_plane_policy_versions" USING btree ("policy_hash");--> statement-breakpoint
CREATE INDEX "event_plane_policy_versions_status_idx" ON "event_plane_policy_versions" USING btree ("status");