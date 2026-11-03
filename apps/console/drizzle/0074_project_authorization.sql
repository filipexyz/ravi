CREATE TABLE "authorization_policy_heads" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "generation" integer NOT NULL DEFAULT 0 CHECK ("generation" >= 0),
  "active_revision_id" uuid,
  "draft_revision_id" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "authorization_policy_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "document" jsonb NOT NULL,
  "digest" text NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "authorization_revisions_org_id_unique" UNIQUE ("organization_id", "id")
);
--> statement-breakpoint
ALTER TABLE "authorization_policy_heads"
  ADD CONSTRAINT "authorization_active_revision_org_fk" FOREIGN KEY ("organization_id", "active_revision_id")
    REFERENCES "authorization_policy_revisions"("organization_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "authorization_draft_revision_org_fk" FOREIGN KEY ("organization_id", "draft_revision_id")
    REFERENCES "authorization_policy_revisions"("organization_id", "id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE "authorization_policy_previews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "revision_id" uuid NOT NULL REFERENCES "authorization_policy_revisions"("id") ON DELETE RESTRICT,
  "generation" integer NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "impact_digest" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "authorization_mutation_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "operation_key" uuid NOT NULL,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "input_digest" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "authorization_mutation_org_key_unique" UNIQUE ("organization_id", "operation_key")
);
--> statement-breakpoint
CREATE TABLE "authorization_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "action" text NOT NULL,
  "project_id" uuid,
  "revision_id" uuid,
  "generation" integer NOT NULL,
  "request_id" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "authorization_audit_org_created_idx" ON "authorization_audit" ("organization_id", "created_at");
--> statement-breakpoint
CREATE TABLE "authorization_bootstrap_receipts" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "operation_key" uuid NOT NULL CONSTRAINT "authorization_bootstrap_operation_unique" UNIQUE,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "identity_id" uuid NOT NULL REFERENCES "auth_identities"("id") ON DELETE RESTRICT,
  "revision_id" uuid NOT NULL REFERENCES "authorization_policy_revisions"("id") ON DELETE RESTRICT,
  "input_digest" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
