-- Guarded: a database that already ran this exact migration under its
-- earlier name (0048_personal_connections, before Page Chat took 0049) has
-- every object below. Migrations run in one transaction, so the presence of
-- connector_tool_policies means the whole body ran; skip it then, run it
-- otherwise.
DO $migration$
BEGIN
	IF to_regclass('public.connector_tool_policies') IS NOT NULL THEN
		RAISE NOTICE '0050_personal_connections: already applied as 0048, skipping';
		RETURN;
	END IF;

	CREATE TYPE "public"."connector_access_mode" AS ENUM('full', 'read_only');

	CREATE TYPE "public"."connector_agent_grant_mode" AS ENUM('person_asking', 'shared');

	CREATE TYPE "public"."connector_agent_grant_status" AS ENUM('active', 'revoked');

	CREATE TYPE "public"."connector_approval_status" AS ENUM('pending', 'approved', 'denied', 'consumed', 'expired');

	CREATE TYPE "public"."connector_consent_request_status" AS ENUM('pending', 'approved', 'denied', 'expired');

	CREATE TYPE "public"."connector_revocation_status" AS ENUM('pending', 'done', 'failed');

	CREATE TYPE "public"."connector_tool_policy" AS ENUM('always_allow', 'needs_approval', 'blocked');

	CREATE TABLE "agent_connector_grants" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"organization_id" uuid NOT NULL,
		"local_installation_id" uuid NOT NULL,
		"agent_id" text NOT NULL,
		"provider" text NOT NULL,
		"mode" "connector_agent_grant_mode" NOT NULL,
		"provider_connection_id" uuid,
		"granted_by_user_id" uuid NOT NULL,
		"conversations_json" jsonb DEFAULT '["dm"]'::jsonb NOT NULL,
		"status" "connector_agent_grant_status" DEFAULT 'active' NOT NULL,
		"revoked_at" timestamp with time zone,
		"created_at" timestamp with time zone DEFAULT now() NOT NULL,
		"updated_at" timestamp with time zone DEFAULT now() NOT NULL
	);

	CREATE TABLE "connector_action_approvals" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"organization_id" uuid NOT NULL,
		"provider_connection_id" uuid NOT NULL,
		"owner_user_id" uuid NOT NULL,
		"requested_by_user_id" uuid,
		"local_installation_id" uuid,
		"cli_session_id" uuid,
		"capability" text NOT NULL,
		"capability_class" text NOT NULL,
		"params_hash" text NOT NULL,
		"preview_encrypted" text,
		"reason" text DEFAULT 'policy' NOT NULL,
		"exec_context_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
		"status" "connector_approval_status" DEFAULT 'pending' NOT NULL,
		"expires_at" timestamp with time zone NOT NULL,
		"decided_at" timestamp with time zone,
		"decided_by_user_id" uuid,
		"consumed_at" timestamp with time zone,
		"created_at" timestamp with time zone DEFAULT now() NOT NULL,
		"updated_at" timestamp with time zone DEFAULT now() NOT NULL
	);

	CREATE TABLE "connector_consent_requests" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"token_hash" text NOT NULL,
		"organization_id" uuid NOT NULL,
		"local_installation_id" uuid NOT NULL,
		"agent_id" text NOT NULL,
		"agent_display_name" text,
		"provider" text NOT NULL,
		"contact_id" text NOT NULL,
		"binding_id" uuid NOT NULL,
		"console_user_id" uuid NOT NULL,
		"requested_by_user_id" uuid,
		"status" "connector_consent_request_status" DEFAULT 'pending' NOT NULL,
		"expires_at" timestamp with time zone NOT NULL,
		"decided_at" timestamp with time zone,
		"grant_id" uuid,
		"created_at" timestamp with time zone DEFAULT now() NOT NULL,
		"updated_at" timestamp with time zone DEFAULT now() NOT NULL
	);

	CREATE TABLE "connector_org_policies" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"organization_id" uuid NOT NULL,
		"provider" text NOT NULL,
		"enabled" boolean DEFAULT true NOT NULL,
		"writes_allowed" boolean DEFAULT true NOT NULL,
		"shared_allowed" boolean DEFAULT false NOT NULL,
		"tool_ceilings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
		"updated_by_user_id" uuid,
		"created_at" timestamp with time zone DEFAULT now() NOT NULL,
		"updated_at" timestamp with time zone DEFAULT now() NOT NULL
	);

	CREATE TABLE "connector_revocation_outbox" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"organization_id" uuid NOT NULL,
		"provider_connection_id" uuid NOT NULL,
		"reason" text NOT NULL,
		"status" "connector_revocation_status" DEFAULT 'pending' NOT NULL,
		"attempts" integer DEFAULT 0 NOT NULL,
		"last_error_code" text,
		"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
		"created_at" timestamp with time zone DEFAULT now() NOT NULL,
		"updated_at" timestamp with time zone DEFAULT now() NOT NULL
	);

	CREATE TABLE "connector_tool_policies" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"provider_connection_id" uuid NOT NULL,
		"organization_id" uuid NOT NULL,
		"capability" text NOT NULL,
		"policy" "connector_tool_policy" NOT NULL,
		"updated_by_user_id" uuid,
		"created_at" timestamp with time zone DEFAULT now() NOT NULL,
		"updated_at" timestamp with time zone DEFAULT now() NOT NULL
	);

	CREATE TABLE "connector_turn_reads" (
		"local_installation_id" uuid NOT NULL,
		"turn_key_hash" text NOT NULL,
		"organization_id" uuid NOT NULL,
		"read_at" timestamp with time zone DEFAULT now() NOT NULL,
		"expires_at" timestamp with time zone NOT NULL,
		CONSTRAINT "connector_turn_reads_local_installation_id_turn_key_hash_pk" PRIMARY KEY("local_installation_id","turn_key_hash")
	);

	CREATE TABLE "connector_usage" (
		"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
		"provider_connection_id" uuid NOT NULL,
		"organization_id" uuid NOT NULL,
		"local_installation_id" uuid NOT NULL,
		"agent_id" text DEFAULT '' NOT NULL,
		"routine_key" text DEFAULT '' NOT NULL,
		"mode" text DEFAULT 'owner' NOT NULL,
		"conversation" text DEFAULT 'terminal' NOT NULL,
		"last_capability" text,
		"use_count" integer DEFAULT 0 NOT NULL,
		"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
		"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
	);

	ALTER TABLE "connector_grants_pending" ALTER COLUMN "project_id" DROP NOT NULL;

	ALTER TABLE "provider_connections" ALTER COLUMN "project_id" DROP NOT NULL;

	-- Connections belong to a person, not to a project (GitHub installations stay per project).
	-- Keep ids; remember the old project in metadata. Idempotent: the connectors Worker re-runs it.
	UPDATE "provider_connections"
	SET "metadata_json" = "metadata_json" || jsonb_build_object('legacyProjectId', "project_id"::text),
		"scope_kind" = 'user',
		"project_id" = NULL,
		"updated_at" = now()
	WHERE "provider" <> 'github' AND "scope_kind" = 'project';

	UPDATE "provider_connections"
	SET "project_id" = NULL, "updated_at" = now()
	WHERE "provider" <> 'github' AND "scope_kind" IN ('user', 'organization') AND "project_id" IS NOT NULL;

	-- Before the per-person account index: if one person connected the same account twice,
	-- only the oldest live row keeps external_account_id.
	WITH "ranked" AS (
		SELECT "id", row_number() OVER (
			PARTITION BY "organization_id", "user_id", "provider", "external_account_id"
			ORDER BY "created_at"
		) AS "rn"
		FROM "provider_connections"
		WHERE "scope_kind" = 'user'
			AND "external_account_id" IS NOT NULL
			AND "status" NOT IN ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider')
	)
	UPDATE "provider_connections" AS "pc"
	SET "metadata_json" = "pc"."metadata_json" || jsonb_build_object('legacyExternalAccountId', "pc"."external_account_id"),
		"external_account_id" = NULL,
		"updated_at" = now()
	FROM "ranked"
	WHERE "pc"."id" = "ranked"."id" AND "ranked"."rn" > 1;

	ALTER TABLE "connector_grants_pending" ADD COLUMN "connect_token_hash" text;

	ALTER TABLE "connector_grants_pending" ADD COLUMN "continued_at" timestamp with time zone;

	ALTER TABLE "connector_grants_pending" ADD COLUMN "authorized_at" timestamp with time zone;

	ALTER TABLE "connector_grants_pending" ADD COLUMN "code_encrypted" text;

	ALTER TABLE "connector_grants_pending" ADD COLUMN "result_token_hash" text;

	ALTER TABLE "connector_grants_pending" ADD COLUMN "target_scope_kind" "connector_scope_kind" DEFAULT 'user' NOT NULL;

	ALTER TABLE "connector_grants_pending" ADD COLUMN "reconnect_connection_id" uuid;

	ALTER TABLE "connector_grants_pending" ADD COLUMN "access_mode" "connector_access_mode" DEFAULT 'full' NOT NULL;

	ALTER TABLE "provider_connections" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;

	ALTER TABLE "provider_connections" ADD COLUMN "managed_by_user_id" uuid;

	ALTER TABLE "provider_connections" ADD COLUMN "last_used_at" timestamp with time zone;

	ALTER TABLE "agent_connector_grants" ADD CONSTRAINT "agent_connector_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "agent_connector_grants" ADD CONSTRAINT "agent_connector_grants_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "agent_connector_grants" ADD CONSTRAINT "agent_connector_grants_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "agent_connector_grants" ADD CONSTRAINT "agent_connector_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_action_approvals" ADD CONSTRAINT "connector_action_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_action_approvals" ADD CONSTRAINT "connector_action_approvals_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_action_approvals" ADD CONSTRAINT "connector_action_approvals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_action_approvals" ADD CONSTRAINT "connector_action_approvals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "connector_action_approvals" ADD CONSTRAINT "connector_action_approvals_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "connector_action_approvals" ADD CONSTRAINT "connector_action_approvals_cli_session_id_cli_sessions_id_fk" FOREIGN KEY ("cli_session_id") REFERENCES "public"."cli_sessions"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "connector_action_approvals" ADD CONSTRAINT "connector_action_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "connector_consent_requests" ADD CONSTRAINT "connector_consent_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_consent_requests" ADD CONSTRAINT "connector_consent_requests_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_consent_requests" ADD CONSTRAINT "connector_consent_requests_binding_id_ravi_actor_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."ravi_actor_bindings"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_consent_requests" ADD CONSTRAINT "connector_consent_requests_console_user_id_users_id_fk" FOREIGN KEY ("console_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_consent_requests" ADD CONSTRAINT "connector_consent_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "connector_consent_requests" ADD CONSTRAINT "connector_consent_requests_grant_id_agent_connector_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_connector_grants"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "connector_org_policies" ADD CONSTRAINT "connector_org_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_org_policies" ADD CONSTRAINT "connector_org_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "connector_revocation_outbox" ADD CONSTRAINT "connector_revocation_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_revocation_outbox" ADD CONSTRAINT "connector_revocation_outbox_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_tool_policies" ADD CONSTRAINT "connector_tool_policies_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_tool_policies" ADD CONSTRAINT "connector_tool_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_tool_policies" ADD CONSTRAINT "connector_tool_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "connector_turn_reads" ADD CONSTRAINT "connector_turn_reads_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_turn_reads" ADD CONSTRAINT "connector_turn_reads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_usage" ADD CONSTRAINT "connector_usage_provider_connection_id_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_usage" ADD CONSTRAINT "connector_usage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

	ALTER TABLE "connector_usage" ADD CONSTRAINT "connector_usage_local_installation_id_local_installations_id_fk" FOREIGN KEY ("local_installation_id") REFERENCES "public"."local_installations"("id") ON DELETE cascade ON UPDATE no action;

	CREATE UNIQUE INDEX "agent_connector_grants_active_unique" ON "agent_connector_grants" USING btree ("local_installation_id","agent_id","provider","granted_by_user_id","mode") WHERE "agent_connector_grants"."status" = 'active';

	CREATE INDEX "agent_connector_grants_org_idx" ON "agent_connector_grants" USING btree ("organization_id");

	CREATE INDEX "agent_connector_grants_granted_by_idx" ON "agent_connector_grants" USING btree ("granted_by_user_id");

	CREATE INDEX "agent_connector_grants_conn_idx" ON "agent_connector_grants" USING btree ("provider_connection_id");

	CREATE INDEX "connector_action_approvals_owner_status_idx" ON "connector_action_approvals" USING btree ("owner_user_id","status");

	CREATE INDEX "connector_action_approvals_conn_idx" ON "connector_action_approvals" USING btree ("provider_connection_id");

	CREATE INDEX "connector_action_approvals_expires_idx" ON "connector_action_approvals" USING btree ("expires_at");

	CREATE UNIQUE INDEX "connector_consent_requests_token_hash_unique" ON "connector_consent_requests" USING btree ("token_hash");

	CREATE UNIQUE INDEX "connector_consent_requests_pending_unique" ON "connector_consent_requests" USING btree ("local_installation_id","agent_id","provider","console_user_id") WHERE "connector_consent_requests"."status" = 'pending';

	CREATE INDEX "connector_consent_requests_user_idx" ON "connector_consent_requests" USING btree ("console_user_id");

	CREATE UNIQUE INDEX "connector_org_policies_org_provider_unique" ON "connector_org_policies" USING btree ("organization_id","provider");

	CREATE INDEX "connector_revocation_outbox_due_idx" ON "connector_revocation_outbox" USING btree ("status","next_attempt_at");

	CREATE INDEX "connector_revocation_outbox_conn_idx" ON "connector_revocation_outbox" USING btree ("provider_connection_id");

	CREATE UNIQUE INDEX "connector_tool_policies_conn_capability_unique" ON "connector_tool_policies" USING btree ("provider_connection_id","capability");

	CREATE INDEX "connector_tool_policies_org_idx" ON "connector_tool_policies" USING btree ("organization_id");

	CREATE INDEX "connector_turn_reads_expires_idx" ON "connector_turn_reads" USING btree ("expires_at");

	CREATE UNIQUE INDEX "connector_usage_key_unique" ON "connector_usage" USING btree ("provider_connection_id","local_installation_id","agent_id","routine_key","mode");

	CREATE INDEX "connector_usage_org_idx" ON "connector_usage" USING btree ("organization_id");

	ALTER TABLE "connector_grants_pending" ADD CONSTRAINT "connector_grants_pending_reconnect_connection_id_provider_connections_id_fk" FOREIGN KEY ("reconnect_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;

	ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_managed_by_user_id_users_id_fk" FOREIGN KEY ("managed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

	CREATE UNIQUE INDEX "connector_grants_pending_connect_hash_unique" ON "connector_grants_pending" USING btree ("connect_token_hash") WHERE "connector_grants_pending"."connect_token_hash" IS NOT NULL;

	CREATE INDEX "provider_connections_external_account_idx" ON "provider_connections" USING btree ("provider","external_account_id");

	CREATE UNIQUE INDEX "provider_connections_user_account_unique" ON "provider_connections" USING btree ("organization_id","user_id","provider","external_account_id") WHERE "provider_connections"."scope_kind" = 'user' AND "provider_connections"."external_account_id" IS NOT NULL AND "provider_connections"."status" NOT IN ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider');

	CREATE UNIQUE INDEX "provider_connections_org_account_unique" ON "provider_connections" USING btree ("organization_id","provider","external_account_id") WHERE "provider_connections"."scope_kind" = 'organization' AND "provider_connections"."external_account_id" IS NOT NULL AND "provider_connections"."status" NOT IN ('revoked_by_user', 'revoked_by_operator', 'revoked_by_provider');

	CREATE UNIQUE INDEX "provider_connections_user_default_unique" ON "provider_connections" USING btree ("organization_id","user_id","provider") WHERE "provider_connections"."is_default" = true AND "provider_connections"."scope_kind" = 'user';

	ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_github_project_check" CHECK ("provider_connections"."provider" <> 'github' OR "provider_connections"."project_id" IS NOT NULL);

	ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_user_no_project_check" CHECK ("provider_connections"."scope_kind" <> 'user' OR "provider_connections"."project_id" IS NULL);

	ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_org_no_project_check" CHECK ("provider_connections"."scope_kind" <> 'organization' OR "provider_connections"."project_id" IS NULL);
END
$migration$;
