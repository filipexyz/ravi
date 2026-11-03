CREATE TABLE "base_charts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"spec_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_actor_type" "actor_type" NOT NULL,
	"created_by_actor_id" text,
	"updated_by_actor_type" "actor_type" NOT NULL,
	"updated_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_row_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"base_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"changed_property_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"before_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_changed" boolean DEFAULT false NOT NULL,
	"last_write_wins" boolean DEFAULT false NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"surface" text NOT NULL,
	"view_id" uuid,
	"request_id" text,
	"client_hint_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"values_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_actor_type" "actor_type" NOT NULL,
	"created_by_actor_id" text,
	"updated_by_actor_type" "actor_type" NOT NULL,
	"updated_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"local_installation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"columns_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"query_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"layout_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_actor_type" "actor_type" NOT NULL,
	"created_by_actor_id" text,
	"updated_by_actor_type" "actor_type" NOT NULL,
	"updated_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_actor_type" "actor_type" NOT NULL,
	"created_by_actor_id" text,
	"updated_by_actor_type" "actor_type" NOT NULL,
	"updated_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_charts" ADD CONSTRAINT "base_charts_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_charts" ADD CONSTRAINT "base_charts_view_id_base_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."base_views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_charts" ADD CONSTRAINT "base_charts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_charts" ADD CONSTRAINT "base_charts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_operations" ADD CONSTRAINT "base_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_operations" ADD CONSTRAINT "base_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_operations" ADD CONSTRAINT "base_operations_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_properties" ADD CONSTRAINT "base_properties_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_properties" ADD CONSTRAINT "base_properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_properties" ADD CONSTRAINT "base_properties_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_row_ledger" ADD CONSTRAINT "base_row_ledger_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_row_ledger" ADD CONSTRAINT "base_row_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_row_ledger" ADD CONSTRAINT "base_row_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_rows" ADD CONSTRAINT "base_rows_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_rows" ADD CONSTRAINT "base_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_rows" ADD CONSTRAINT "base_rows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_subscriptions" ADD CONSTRAINT "base_subscriptions_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_subscriptions" ADD CONSTRAINT "base_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_subscriptions" ADD CONSTRAINT "base_subscriptions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_subscriptions" ADD CONSTRAINT "base_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_subscriptions" ADD CONSTRAINT "base_subscriptions_installation_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_views" ADD CONSTRAINT "base_views_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_views" ADD CONSTRAINT "base_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_views" ADD CONSTRAINT "base_views_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "base_charts_base_status_idx" ON "base_charts" USING btree ("base_id","status");--> statement-breakpoint
CREATE INDEX "base_charts_view_id_idx" ON "base_charts" USING btree ("view_id");--> statement-breakpoint
CREATE INDEX "base_charts_organization_id_idx" ON "base_charts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "base_charts_project_id_idx" ON "base_charts" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "base_operations_scope_key_unique" ON "base_operations" USING btree ("organization_id","source_kind","source_id","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "base_operations_base_id_idx" ON "base_operations" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "base_operations_project_id_idx" ON "base_operations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "base_operations_expires_at_idx" ON "base_operations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "base_properties_base_key_active_unique" ON "base_properties" USING btree ("base_id","key") WHERE "base_properties"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "base_properties_base_id_idx" ON "base_properties" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "base_properties_organization_id_idx" ON "base_properties" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "base_properties_project_id_idx" ON "base_properties" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "base_row_ledger_sequence_unique" ON "base_row_ledger" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "base_row_ledger_row_sequence_idx" ON "base_row_ledger" USING btree ("row_id","sequence");--> statement-breakpoint
CREATE INDEX "base_row_ledger_base_sequence_idx" ON "base_row_ledger" USING btree ("base_id","sequence");--> statement-breakpoint
CREATE INDEX "base_row_ledger_organization_id_idx" ON "base_row_ledger" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "base_row_ledger_project_id_idx" ON "base_row_ledger" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "base_rows_base_active_created_idx" ON "base_rows" USING btree ("base_id","archived_at","created_at","id");--> statement-breakpoint
CREATE INDEX "base_rows_values_json_gin_idx" ON "base_rows" USING gin ("values_json" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "base_rows_organization_id_idx" ON "base_rows" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "base_rows_project_id_idx" ON "base_rows" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "base_subscriptions_base_installation_active_unique" ON "base_subscriptions" USING btree ("base_id","local_installation_id") WHERE "base_subscriptions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "base_subscriptions_base_status_idx" ON "base_subscriptions" USING btree ("base_id","status");--> statement-breakpoint
CREATE INDEX "base_subscriptions_installation_idx" ON "base_subscriptions" USING btree ("local_installation_id");--> statement-breakpoint
CREATE INDEX "base_subscriptions_organization_id_idx" ON "base_subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "base_subscriptions_project_id_idx" ON "base_subscriptions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "base_views_base_status_idx" ON "base_views" USING btree ("base_id","status");--> statement-breakpoint
CREATE INDEX "base_views_organization_id_idx" ON "base_views" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "base_views_project_id_idx" ON "base_views" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bases_project_slug_unique" ON "bases" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "bases_organization_id_idx" ON "bases" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bases_project_status_idx" ON "bases" USING btree ("project_id","status");