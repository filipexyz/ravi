-- Connector → project scope migration.
--
-- Connectors are now scoped to a project rather than the organization.
-- Existing rows are dropped per operator decision (Luis: "pode excluir os
-- existentes") because there is no safe automatic assignment to a project.
-- This drops connections + credentials (cascade) + pending grants + step-up
-- challenges so we can flip project_id to NOT NULL cleanly.

DELETE FROM "connector_stepup_challenges";--> statement-breakpoint
DELETE FROM "connector_grants_pending";--> statement-breakpoint
DELETE FROM "connector_credentials";--> statement-breakpoint
DELETE FROM "provider_connections";--> statement-breakpoint

ALTER TABLE "provider_connections" DROP CONSTRAINT "provider_connections_project_id_projects_id_fk";--> statement-breakpoint
DROP INDEX "provider_connections_org_provider_external_unique";--> statement-breakpoint
ALTER TABLE "provider_connections" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_grants_pending" ADD COLUMN "project_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_grants_pending" ADD CONSTRAINT "connector_grants_pending_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_grants_pending_project_idx" ON "connector_grants_pending" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_project_provider_external_unique" ON "provider_connections" USING btree ("project_id","provider","external_account_id");
