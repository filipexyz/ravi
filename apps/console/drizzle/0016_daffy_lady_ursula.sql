CREATE TYPE "public"."console_watch_placement" AS ENUM('console', 'local', 'auto');--> statement-breakpoint
CREATE TYPE "public"."console_watch_status" AS ENUM('active', 'disabled', 'deleted', 'degraded');--> statement-breakpoint
CREATE TYPE "public"."provider_webhook_delivery_status" AS ENUM('received', 'matched', 'ignored', 'failed');--> statement-breakpoint
CREATE TABLE "console_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"created_by_user_id" uuid,
	"local_installation_id" uuid,
	"provider" text NOT NULL,
	"placement" "console_watch_placement" DEFAULT 'console' NOT NULL,
	"provider_connection_id" uuid,
	"provider_installation_id" text,
	"provider_resource_id" text,
	"resource_ref" text NOT NULL,
	"watch_key" text NOT NULL,
	"name" text,
	"description" text,
	"event_types_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filters_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivery_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "console_watch_status" DEFAULT 'active' NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"last_error_code" text,
	"disabled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"provider_installation_id" text NOT NULL,
	"provider_resource_id" text,
	"provider_event_type" text NOT NULL,
	"status" "provider_webhook_delivery_status" DEFAULT 'received' NOT NULL,
	"matched_watch_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inbox_item_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_id" text NOT NULL,
	"safe_envelope_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "console_watches" ADD CONSTRAINT "console_watches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_watches" ADD CONSTRAINT "console_watches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_watches" ADD CONSTRAINT "console_watches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_watches" ADD CONSTRAINT "console_watches_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_watches" ADD CONSTRAINT "console_watches_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_webhook_deliveries" ADD CONSTRAINT "provider_webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "console_watches_org_watch_key_unique" ON "console_watches" USING btree ("organization_id","watch_key");--> statement-breakpoint
CREATE INDEX "console_watches_org_idx" ON "console_watches" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "console_watches_project_idx" ON "console_watches" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "console_watches_created_by_idx" ON "console_watches" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "console_watches_installation_idx" ON "console_watches" USING btree ("local_installation_id");--> statement-breakpoint
CREATE INDEX "console_watches_provider_idx" ON "console_watches" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "console_watches_status_idx" ON "console_watches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "console_watches_provider_resource_idx" ON "console_watches" USING btree ("provider","provider_installation_id","provider_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_webhook_deliveries_provider_delivery_unique" ON "provider_webhook_deliveries" USING btree ("provider","provider_installation_id","provider_delivery_id");--> statement-breakpoint
CREATE INDEX "provider_webhook_deliveries_org_idx" ON "provider_webhook_deliveries" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "provider_webhook_deliveries_provider_idx" ON "provider_webhook_deliveries" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "provider_webhook_deliveries_status_idx" ON "provider_webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "provider_webhook_deliveries_resource_idx" ON "provider_webhook_deliveries" USING btree ("provider","provider_installation_id","provider_resource_id");