CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"site_id" uuid,
	"release_id" uuid,
	"route_id" uuid,
	"artifact_id" uuid,
	"artifact_version_id" uuid,
	"asset_id" uuid,
	"publish_id" uuid,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"metric_key" text NOT NULL,
	"quantity" numeric(20, 6) DEFAULT '0' NOT NULL,
	"unit" text DEFAULT 'count' NOT NULL,
	"dimensions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"measurements_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_rollups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"site_id" uuid,
	"artifact_id" uuid,
	"artifact_version_id" uuid,
	"asset_id" uuid,
	"metric_key" text NOT NULL,
	"interval" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"dimension_hash" text NOT NULL,
	"dimensions_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quantity" numeric(20, 6) DEFAULT '0' NOT NULL,
	"unit" text DEFAULT 'count' NOT NULL,
	"estimated_cost_usd" numeric(20, 8),
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_release_id_page_site_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."page_site_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_route_id_page_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."page_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_publish_id_page_publishes_id_fk" FOREIGN KEY ("publish_id") REFERENCES "public"."page_publishes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_site_id_page_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."page_sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idempotency_unique" ON "usage_events" USING btree ("organization_id","event_type","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_events_org_occurred_idx" ON "usage_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_project_occurred_idx" ON "usage_events" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_site_occurred_idx" ON "usage_events" USING btree ("site_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_artifact_version_idx" ON "usage_events" USING btree ("artifact_version_id");--> statement-breakpoint
CREATE INDEX "usage_events_asset_idx" ON "usage_events" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "usage_events_publish_idx" ON "usage_events" USING btree ("publish_id");--> statement-breakpoint
CREATE INDEX "usage_events_metric_idx" ON "usage_events" USING btree ("metric_key");--> statement-breakpoint
CREATE INDEX "usage_events_request_idx" ON "usage_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_rollups_window_unique" ON "usage_rollups" USING btree ("organization_id","dimension_hash","metric_key","interval","window_start");--> statement-breakpoint
CREATE INDEX "usage_rollups_org_window_idx" ON "usage_rollups" USING btree ("organization_id","window_start");--> statement-breakpoint
CREATE INDEX "usage_rollups_project_window_idx" ON "usage_rollups" USING btree ("project_id","window_start");--> statement-breakpoint
CREATE INDEX "usage_rollups_site_window_idx" ON "usage_rollups" USING btree ("site_id","window_start");--> statement-breakpoint
CREATE INDEX "usage_rollups_metric_idx" ON "usage_rollups" USING btree ("metric_key");