-- No secret plaintext is stored in these tables. Values live in Vault KV v2.
CREATE TABLE "fleet_credentials" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "label" text NOT NULL,
  "kind" text NOT NULL CHECK (kind IN ('ssh_private_key', 'oidc_client_secret')),
  "binding_json" jsonb NOT NULL DEFAULT 'null'::jsonb,
  "revision" integer NOT NULL CHECK (revision > 0),
  "secret_version" integer NOT NULL CHECK (secret_version > 0),
  "status" text NOT NULL CHECK (status IN ('active', 'revoked')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id)
);
--> statement-breakpoint
CREATE TABLE "fleet_installations" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "label" text NOT NULL, "hostname" text NOT NULL,
  "port" integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  "username" text NOT NULL CHECK (username <> 'root'),
  "host_fingerprint" text NOT NULL,
  "credential_id" uuid NOT NULL,
  "revision" integer NOT NULL CHECK (revision > 0),
  "status" text NOT NULL CHECK (status IN ('draft', 'tested', 'active', 'failed')),
  "tested_credential_revision" integer, "tested_at" timestamptz,
  "cli_version" text, "failure_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, credential_id) REFERENCES fleet_credentials(organization_id, id)
);
--> statement-breakpoint
CREATE TABLE "fleet_mutation_receipts" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "result_json" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, operation_id)
);
--> statement-breakpoint
CREATE TABLE "fleet_sso_connections" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "revision" integer NOT NULL CHECK (revision > 0),
  "status" text NOT NULL CHECK (status IN ('draft', 'tested', 'active', 'retired')),
  "issuer" text NOT NULL, "client_id" text NOT NULL, "credential_id" uuid NOT NULL,
  "credential_version" integer NOT NULL CHECK (credential_version > 0),
  "config_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "tested_at" timestamptz, "tested_by" uuid REFERENCES users(id),
  "tested_session_hash" text, "tested_subject" text, "tested_email" text, "tested_groups" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, credential_id) REFERENCES fleet_credentials(organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX fleet_sso_one_active ON fleet_sso_connections(organization_id) WHERE status = 'active';
--> statement-breakpoint
CREATE TABLE fleet_sso_challenges (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL, connection_id uuid NOT NULL, connection_revision integer NOT NULL,
  credential_version integer NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
  session_hash text NOT NULL, state_hash text NOT NULL UNIQUE, input_hash text NOT NULL,
  transaction_ciphertext text NOT NULL, authorization_url text NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,connection_id) REFERENCES fleet_sso_connections(organization_id,id)
);
--> statement-breakpoint
ALTER TABLE console_browser_sessions ADD COLUMN oidc_groups jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
CREATE TABLE fleet_bootstrap_grants (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id), token_hash text NOT NULL,
  expected_email text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  claimed_by uuid REFERENCES users(id), attempt_id uuid, state_hash text,
  transaction_ciphertext text, authorization_url text, attempt_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE fleet_onboarding (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id), completed_at timestamptz NOT NULL,
  completed_by uuid NOT NULL REFERENCES users(id), snapshot_hash text NOT NULL
);
