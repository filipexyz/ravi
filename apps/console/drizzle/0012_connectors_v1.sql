CREATE TYPE "public"."connector_credential_kind" AS ENUM('access_token', 'refresh_token', 'id_token');--> statement-breakpoint
CREATE TYPE "public"."connector_grant_origin" AS ENUM('cli', 'ui');--> statement-breakpoint
CREATE TYPE "public"."connector_grant_status" AS ENUM('pending', 'consumed', 'expired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."connector_scope_kind" AS ENUM('user', 'organization', 'project');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('active', 'degraded', 'suspended', 'revoke_pending', 'revoked_by_user', 'revoked_by_operator', 'revoked_by_provider', 'tampered');--> statement-breakpoint
CREATE TYPE "public"."connector_stepup_factor" AS ENUM('passkey', 'totp', 'sms', 'password');--> statement-breakpoint
CREATE TYPE "public"."connector_stepup_status" AS ENUM('issued', 'consumed', 'expired', 'rejected');--> statement-breakpoint
CREATE TABLE "connector_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_connection_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"payload_kind" "connector_credential_kind" NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"aad_hash" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"dek_key_version" integer NOT NULL,
	"payload_key_version" integer DEFAULT 1 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"refresh_supported" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_grants_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state_token_hash" text NOT NULL,
	"pkce_verifier_encrypted" text,
	"requested_scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_display_name" text,
	"origin" "connector_grant_origin" NOT NULL,
	"cli_session_id" uuid,
	"status" "connector_grant_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"rejected_reason" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_stepup_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_connection_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"capability_class" text NOT NULL,
	"factor" "connector_stepup_factor",
	"status" "connector_stepup_status" DEFAULT 'issued' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"rejected_reason" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"user_id" uuid,
	"provider" text NOT NULL,
	"scope_kind" "connector_scope_kind" NOT NULL,
	"external_account_id" text,
	"external_account_login" text,
	"display_name" text NOT NULL,
	"status" "connector_status" DEFAULT 'active' NOT NULL,
	"scopes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requires_reauth" boolean DEFAULT false NOT NULL,
	"granted_by_user_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_reauth_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_grants_pending" ADD CONSTRAINT "connector_grants_pending_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_grants_pending" ADD CONSTRAINT "connector_grants_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_grants_pending" ADD CONSTRAINT "connector_grants_pending_cli_session_id_cli_sessions_id_fk" FOREIGN KEY ("cli_session_id") REFERENCES "public"."cli_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_stepup_challenges" ADD CONSTRAINT "connector_stepup_challenges_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_stepup_challenges" ADD CONSTRAINT "connector_stepup_challenges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_stepup_challenges" ADD CONSTRAINT "connector_stepup_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_credentials_org_idx" ON "connector_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "connector_credentials_user_idx" ON "connector_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_credentials_conn_kind_unique" ON "connector_credentials" USING btree ("provider_connection_id","payload_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_grants_pending_state_hash_unique" ON "connector_grants_pending" USING btree ("state_token_hash");--> statement-breakpoint
CREATE INDEX "connector_grants_pending_user_idx" ON "connector_grants_pending" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "connector_grants_pending_org_idx" ON "connector_grants_pending" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "connector_grants_pending_status_idx" ON "connector_grants_pending" USING btree ("status");--> statement-breakpoint
CREATE INDEX "connector_grants_pending_expires_idx" ON "connector_grants_pending" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_stepup_token_hash_unique" ON "connector_stepup_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "connector_stepup_conn_idx" ON "connector_stepup_challenges" USING btree ("provider_connection_id");--> statement-breakpoint
CREATE INDEX "connector_stepup_user_idx" ON "connector_stepup_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "connector_stepup_status_idx" ON "connector_stepup_challenges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "connector_stepup_expires_idx" ON "connector_stepup_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "provider_connections_org_idx" ON "provider_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "provider_connections_user_idx" ON "provider_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "provider_connections_project_idx" ON "provider_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "provider_connections_provider_idx" ON "provider_connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "provider_connections_status_idx" ON "provider_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_org_provider_external_unique" ON "provider_connections" USING btree ("organization_id","provider","external_account_id");