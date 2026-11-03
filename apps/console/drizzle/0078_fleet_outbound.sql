-- Outbound management reuses local_installations identity, not a second installation catalog.
ALTER TABLE local_installations ADD COLUMN management_revision integer NOT NULL DEFAULT 0;
CREATE TABLE fleet_associations (
  id uuid PRIMARY KEY, challenge_hash text NOT NULL UNIQUE, csr text NOT NULL,
  fingerprint text NOT NULL, name text NOT NULL, platform text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  organization_id uuid REFERENCES organizations(id), installation_id uuid REFERENCES local_installations(id),
  approved_by uuid REFERENCES users(id), approved_session text, approval_operation uuid,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fleet_associations_expiry ON fleet_associations(expires_at);
CREATE TABLE fleet_node_credentials (
  id uuid PRIMARY KEY, installation_id uuid NOT NULL REFERENCES local_installations(id),
  revision integer NOT NULL, fingerprint text NOT NULL UNIQUE, certificate text NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, rotation_operation uuid, csr_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(installation_id,revision)
);
CREATE UNIQUE INDEX fleet_node_credential_active ON fleet_node_credentials(installation_id) WHERE revoked_at IS NULL;
CREATE TABLE fleet_node_operations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
  installation_id uuid NOT NULL REFERENCES local_installations(id),
  subject_id uuid NOT NULL REFERENCES users(id), session_id text NOT NULL,
  command jsonb NOT NULL, digest text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','delivered','succeeded','failed','uncertain','cancelled')),
  installation_revision integer NOT NULL, result jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL, delivered_at timestamptz, completed_at timestamptz
);
CREATE INDEX fleet_node_operations_queue ON fleet_node_operations(installation_id,state,created_at);
CREATE TABLE fleet_node_mutations (
  organization_id uuid NOT NULL REFERENCES organizations(id), subject_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL, action text NOT NULL, digest text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,subject_id,operation_id)
);
