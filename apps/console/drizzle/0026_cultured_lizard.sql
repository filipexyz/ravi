CREATE TYPE "public"."managed_execution_harness_status" AS ENUM('draft', 'active', 'disabled', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."managed_execution_tool_projection_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "managed_execution_harness_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"harness_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"app_id" text NOT NULL,
	"app_version" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"manifest_source" text,
	"manifest_path" text,
	"required" boolean DEFAULT true NOT NULL,
	"selected_operations_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_skills_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"permission_projection_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_projection_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_execution_harnesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "managed_execution_harness_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"base_agent_id" text,
	"base_profile_id" text,
	"runtime_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"harness_hash" text NOT NULL,
	"compiled_bundle_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_actor_type" "actor_type" DEFAULT 'user' NOT NULL,
	"created_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_execution_tool_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"harness_id" uuid NOT NULL,
	"harness_app_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"interface_name" text NOT NULL,
	"mutating" boolean DEFAULT false NOT NULL,
	"permission_requirement_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_schema_json" jsonb,
	"output_schema_json" jsonb,
	"status" "managed_execution_tool_projection_status" DEFAULT 'active' NOT NULL,
	"safe_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_execution_harness_apps" ADD CONSTRAINT "managed_execution_harness_apps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_execution_harness_apps" ADD CONSTRAINT "managed_execution_harness_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_execution_harness_apps" ADD CONSTRAINT "managed_execution_harness_apps_harness_id_managed_execution_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."managed_execution_harnesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_execution_harnesses" ADD CONSTRAINT "managed_execution_harnesses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_execution_harnesses" ADD CONSTRAINT "managed_execution_harnesses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_execution_tool_projections" ADD CONSTRAINT "managed_execution_tool_projections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_execution_tool_projections" ADD CONSTRAINT "managed_execution_tool_projections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_execution_tool_projections" ADD CONSTRAINT "managed_execution_tool_projections_harness_id_managed_execution_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."managed_execution_harnesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_execution_tool_projections" ADD CONSTRAINT "managed_execution_tool_projections_harness_app_id_managed_execution_harness_apps_id_fk" FOREIGN KEY ("harness_app_id") REFERENCES "public"."managed_execution_harness_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_execution_harness_apps_harness_app_unique" ON "managed_execution_harness_apps" USING btree ("harness_id","app_id");--> statement-breakpoint
CREATE INDEX "managed_execution_harness_apps_org_idx" ON "managed_execution_harness_apps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "managed_execution_harness_apps_project_idx" ON "managed_execution_harness_apps" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "managed_execution_harness_apps_harness_idx" ON "managed_execution_harness_apps" USING btree ("harness_id","position");--> statement-breakpoint
CREATE INDEX "managed_execution_harness_apps_manifest_hash_idx" ON "managed_execution_harness_apps" USING btree ("manifest_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_execution_harnesses_org_slug_unique" ON "managed_execution_harnesses" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "managed_execution_harnesses_org_status_idx" ON "managed_execution_harnesses" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "managed_execution_harnesses_project_idx" ON "managed_execution_harnesses" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "managed_execution_harnesses_base_agent_idx" ON "managed_execution_harnesses" USING btree ("organization_id","base_agent_id");--> statement-breakpoint
CREATE INDEX "managed_execution_harnesses_hash_idx" ON "managed_execution_harnesses" USING btree ("harness_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_execution_tool_projections_harness_tool_unique" ON "managed_execution_tool_projections" USING btree ("harness_id","tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_execution_tool_projections_harness_operation_unique" ON "managed_execution_tool_projections" USING btree ("harness_id","app_id","operation_id");--> statement-breakpoint
CREATE INDEX "managed_execution_tool_projections_org_idx" ON "managed_execution_tool_projections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "managed_execution_tool_projections_project_idx" ON "managed_execution_tool_projections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "managed_execution_tool_projections_harness_idx" ON "managed_execution_tool_projections" USING btree ("harness_id");--> statement-breakpoint
CREATE INDEX "managed_execution_tool_projections_app_idx" ON "managed_execution_tool_projections" USING btree ("app_id");