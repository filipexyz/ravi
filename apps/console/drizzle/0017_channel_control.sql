CREATE TYPE "public"."channel_host_provider" AS ENUM('omni');--> statement-breakpoint
CREATE TYPE "public"."channel_host_environment" AS ENUM('production', 'staging', 'development');--> statement-breakpoint
CREATE TYPE "public"."channel_host_tenant_mode" AS ENUM('shared', 'dedicated');--> statement-breakpoint
CREATE TYPE "public"."channel_host_status" AS ENUM('active', 'degraded', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."channel_instance_channel" AS ENUM('whatsapp');--> statement-breakpoint
CREATE TYPE "public"."channel_instance_provider" AS ENUM('omni');--> statement-breakpoint
CREATE TYPE "public"."channel_instance_status" AS ENUM('provisioning', 'qr_pending', 'connected', 'disconnected', 'degraded', 'disabled', 'deleting', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."channel_credential_kind" AS ENUM('omni_instance_api_key');--> statement-breakpoint
CREATE TYPE "public"."channel_credential_status" AS ENUM('active', 'rotated', 'revoked', 'tampered');--> statement-breakpoint
CREATE TYPE "public"."channel_event_severity" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."channel_idempotency_status" AS ENUM('started', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "channel_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "channel_host_provider" NOT NULL,
	"display_name" text NOT NULL,
	"environment" "channel_host_environment" DEFAULT 'production' NOT NULL,
	"region" text,
	"tenant_mode" "channel_host_tenant_mode" DEFAULT 'shared' NOT NULL,
	"control_base_url_ref" text NOT NULL,
	"status" "channel_host_status" DEFAULT 'active' NOT NULL,
	"capacity_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_health_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"channel" "channel_instance_channel" NOT NULL,
	"provider" "channel_instance_provider" NOT NULL,
	"external_instance_id" text NOT NULL,
	"external_instance_name" text NOT NULL,
	"display_name" text NOT NULL,
	"phone_e164" text,
	"phone_display" text,
	"status" "channel_instance_status" DEFAULT 'provisioning' NOT NULL,
	"connection_state" text,
	"created_by_user_id" uuid,
	"last_connected_at" timestamp with time zone,
	"last_disconnected_at" timestamp with time zone,
	"last_health_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_instance_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_instance_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"credential_kind" "channel_credential_kind" NOT NULL,
	"key_prefix" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"aad_hash" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"dek_key_version" integer NOT NULL,
	"payload_key_version" integer DEFAULT 1 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" "channel_credential_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_instance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"channel_instance_id" uuid,
	"host_id" uuid,
	"event_type" text NOT NULL,
	"severity" "channel_event_severity" DEFAULT 'info' NOT NULL,
	"request_id" text NOT NULL,
	"actor_type" "actor_type",
	"actor_id" text,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_operation_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "channel_idempotency_status" DEFAULT 'started' NOT NULL,
	"channel_instance_id" uuid,
	"response_json" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_instances" ADD CONSTRAINT "channel_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD CONSTRAINT "channel_instances_host_id_channel_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."channel_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instances" ADD CONSTRAINT "channel_instances_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instance_credentials" ADD CONSTRAINT "channel_instance_credentials_channel_instance_id_channel_instances_id_fk" FOREIGN KEY ("channel_instance_id") REFERENCES "public"."channel_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instance_credentials" ADD CONSTRAINT "channel_instance_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instance_events" ADD CONSTRAINT "channel_instance_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instance_events" ADD CONSTRAINT "channel_instance_events_channel_instance_id_channel_instances_id_fk" FOREIGN KEY ("channel_instance_id") REFERENCES "public"."channel_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_instance_events" ADD CONSTRAINT "channel_instance_events_host_id_channel_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."channel_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_operation_idempotency" ADD CONSTRAINT "channel_operation_idempotency_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_operation_idempotency" ADD CONSTRAINT "channel_operation_idempotency_channel_instance_id_channel_instances_id_fk" FOREIGN KEY ("channel_instance_id") REFERENCES "public"."channel_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_hosts_provider_idx" ON "channel_hosts" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "channel_hosts_status_idx" ON "channel_hosts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "channel_hosts_environment_idx" ON "channel_hosts" USING btree ("environment");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_instances_host_external_unique" ON "channel_instances" USING btree ("host_id","external_instance_id");--> statement-breakpoint
CREATE INDEX "channel_instances_org_idx" ON "channel_instances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "channel_instances_host_idx" ON "channel_instances" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "channel_instances_status_idx" ON "channel_instances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "channel_instances_channel_idx" ON "channel_instances" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "channel_instances_created_by_idx" ON "channel_instances" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_instance_credentials_active_unique" ON "channel_instance_credentials" USING btree ("channel_instance_id","credential_kind") WHERE "channel_instance_credentials"."status" = 'active';--> statement-breakpoint
CREATE INDEX "channel_instance_credentials_org_idx" ON "channel_instance_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "channel_instance_credentials_instance_idx" ON "channel_instance_credentials" USING btree ("channel_instance_id");--> statement-breakpoint
CREATE INDEX "channel_instance_credentials_prefix_idx" ON "channel_instance_credentials" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "channel_instance_credentials_status_idx" ON "channel_instance_credentials" USING btree ("status");--> statement-breakpoint
CREATE INDEX "channel_instance_events_org_idx" ON "channel_instance_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "channel_instance_events_instance_idx" ON "channel_instance_events" USING btree ("channel_instance_id","created_at");--> statement-breakpoint
CREATE INDEX "channel_instance_events_host_idx" ON "channel_instance_events" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "channel_instance_events_type_idx" ON "channel_instance_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "channel_instance_events_request_idx" ON "channel_instance_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_operation_idempotency_org_key_operation_unique" ON "channel_operation_idempotency" USING btree ("organization_id","idempotency_key","operation");--> statement-breakpoint
CREATE INDEX "channel_operation_idempotency_org_idx" ON "channel_operation_idempotency" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "channel_operation_idempotency_status_idx" ON "channel_operation_idempotency" USING btree ("status");--> statement-breakpoint
CREATE INDEX "channel_operation_idempotency_expires_idx" ON "channel_operation_idempotency" USING btree ("expires_at");
