-- GitHub App installations move from projects to the organization. Idempotent,
-- like 0057-0065: a preview build may apply it to a shared database before it
-- merges, and the code running there keeps working without the old check.
ALTER TABLE "provider_connections" DROP CONSTRAINT IF EXISTS "provider_connections_github_project_check";--> statement-breakpoint
ALTER TABLE "provider_connections" DROP CONSTRAINT IF EXISTS "provider_connections_github_scope_check";--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_github_scope_check" CHECK ("provider_connections"."provider" <> 'github' OR "provider_connections"."scope_kind" IN ('organization', 'project'));
