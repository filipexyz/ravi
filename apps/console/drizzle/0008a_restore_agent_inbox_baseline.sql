-- Reconstructed exactly from 0008_snapshot.json; original placeholder/hash preserved.
CREATE TYPE "public"."agent_inbox_delivery_mode" AS ENUM ('poll');
--> statement-breakpoint
CREATE TYPE "public"."agent_inbox_receipt_status" AS ENUM ('leased', 'delivered', 'read', 'resolved', 'failed', 'skipped');
--> statement-breakpoint
CREATE TYPE "public"."agent_inbox_sensitivity" AS ENUM ('metadata', 'customer_data', 'secret_adjacent', 'restricted');
--> statement-breakpoint
CREATE TYPE "public"."agent_inbox_severity" AS ENUM ('info', 'success', 'warning', 'error', 'action_required');
--> statement-breakpoint
CREATE TYPE "public"."agent_inbox_subscription_status" AS ENUM ('active', 'paused', 'revoked');
--> statement-breakpoint
CREATE TABLE "agent_inbox_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence" bigserial NOT NULL,
  "organization_id" uuid NOT NULL,
  "project_id" uuid,
  "source_type" text NOT NULL,
  "source_id" text,
  "event_type" text NOT NULL,
  "category" text NOT NULL,
  "severity" "public"."agent_inbox_severity" DEFAULT 'info' NOT NULL,
  "sensitivity" "public"."agent_inbox_sensitivity" DEFAULT 'metadata' NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "actor_type" "public"."actor_type",
  "actor_id" text,
  "target_type" text NOT NULL,
  "target_id" text,
  "dedupe_key" text NOT NULL,
  "payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "links_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_inbox_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "local_installation_id" uuid,
  "name" text NOT NULL,
  "status" "public"."agent_inbox_subscription_status" DEFAULT 'active' NOT NULL,
  "delivery_mode" "public"."agent_inbox_delivery_mode" DEFAULT 'poll' NOT NULL,
  "filters_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "capabilities_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_poll_at" timestamp with time zone,
  "last_delivered_sequence" bigint DEFAULT 0 NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_inbox_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subscription_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "status" "public"."agent_inbox_receipt_status" DEFAULT 'leased' NOT NULL,
  "lease_id" text,
  "lease_expires_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "last_error_code" text,
  "local_event_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_inbox_watermarks" (
  "organization_id" uuid PRIMARY KEY NOT NULL,
  "generation" bigint DEFAULT 0 NOT NULL,
  "latest_sequence" bigint DEFAULT 0 NOT NULL,
  "latest_item_at" timestamp with time zone,
  "cache_key" text DEFAULT '0' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects" ("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_items_sequence_unique" ON "agent_inbox_items" USING btree ("sequence" ASC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_items_org_dedupe_unique" ON "agent_inbox_items" USING btree ("organization_id" ASC NULLS LAST, "dedupe_key" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_items_org_sequence_idx" ON "agent_inbox_items" USING btree ("organization_id" ASC NULLS LAST, "sequence" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_items_project_sequence_idx" ON "agent_inbox_items" USING btree ("project_id" ASC NULLS LAST, "sequence" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_items_source_idx" ON "agent_inbox_items" USING btree ("source_type" ASC NULLS LAST, "source_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_items_event_type_idx" ON "agent_inbox_items" USING btree ("event_type" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_items_category_idx" ON "agent_inbox_items" USING btree ("category" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_items_severity_idx" ON "agent_inbox_items" USING btree ("severity" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_items_created_at_idx" ON "agent_inbox_items" USING btree ("created_at" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "agent_inbox_subscriptions" ADD CONSTRAINT "agent_inbox_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_inbox_subscriptions" ADD CONSTRAINT "agent_inbox_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_inbox_subscriptions" ADD CONSTRAINT "agent_inbox_subscriptions_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_subscriptions_global_unique" ON "agent_inbox_subscriptions" USING btree ("organization_id" ASC NULLS LAST, "local_installation_id" ASC NULLS LAST, "name" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_subscriptions_org_idx" ON "agent_inbox_subscriptions" USING btree ("organization_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_subscriptions_user_idx" ON "agent_inbox_subscriptions" USING btree ("user_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_subscriptions_installation_idx" ON "agent_inbox_subscriptions" USING btree ("local_installation_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_subscriptions_status_idx" ON "agent_inbox_subscriptions" USING btree ("status" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "agent_inbox_receipts" ADD CONSTRAINT "agent_inbox_receipts_subscription_id_agent_inbox_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."agent_inbox_subscriptions" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_inbox_receipts" ADD CONSTRAINT "agent_inbox_receipts_item_id_agent_inbox_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."agent_inbox_items" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_receipts_subscription_item_unique" ON "agent_inbox_receipts" USING btree ("subscription_id" ASC NULLS LAST, "item_id" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_receipts_subscription_status_idx" ON "agent_inbox_receipts" USING btree ("subscription_id" ASC NULLS LAST, "status" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_receipts_lease_expires_at_idx" ON "agent_inbox_receipts" USING btree ("lease_expires_at" ASC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "agent_inbox_receipts_item_idx" ON "agent_inbox_receipts" USING btree ("item_id" ASC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "agent_inbox_watermarks" ADD CONSTRAINT "agent_inbox_watermarks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations" ("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "agent_inbox_watermarks_updated_at_idx" ON "agent_inbox_watermarks" USING btree ("updated_at" ASC NULLS LAST);
