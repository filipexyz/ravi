-- Additive only: legacy ownership is deliberately unknown. Never infer creator.
CREATE TABLE api_key_service_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id)
);
--> statement-breakpoint
ALTER TABLE api_keys
  ADD COLUMN subject_kind text NOT NULL DEFAULT 'unclassified',
  ADD COLUMN subject_user_id uuid,
  ADD COLUMN service_principal_id uuid,
  ADD COLUMN hash_version text NOT NULL DEFAULT 'legacy',
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT api_keys_subject_shape CHECK (
    (subject_kind='unclassified' AND subject_user_id IS NULL AND service_principal_id IS NULL) OR
    (subject_kind='user' AND subject_user_id IS NOT NULL AND service_principal_id IS NULL) OR
    (subject_kind='service' AND subject_user_id IS NULL AND service_principal_id IS NOT NULL)),
  ADD CONSTRAINT api_keys_revision_positive CHECK (revision > 0),
  ADD CONSTRAINT api_keys_hash_version CHECK (hash_version IN ('legacy','sha256')),
  ADD CONSTRAINT api_keys_user_org_fk FOREIGN KEY (organization_id,subject_user_id)
    REFERENCES organization_memberships(organization_id,user_id),
  ADD CONSTRAINT api_keys_service_org_fk FOREIGN KEY (organization_id,service_principal_id)
    REFERENCES api_key_service_principals(organization_id,id);
--> statement-breakpoint
CREATE INDEX api_keys_subject_user_idx ON api_keys(organization_id,subject_user_id);
CREATE INDEX api_keys_service_idx ON api_keys(organization_id,service_principal_id);
--> statement-breakpoint
-- Permanent terminal-state guard: rollback or another writer cannot revive keys.
CREATE FUNCTION api_key_terminal_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='revoked' AND NEW.status<>'revoked' THEN
    RAISE EXCEPTION 'api_key_revocation_terminal';
  END IF;
  IF OLD.subject_kind<>'unclassified' AND
    (NEW.subject_kind IS DISTINCT FROM OLD.subject_kind OR
     NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id OR
     NEW.service_principal_id IS DISTINCT FROM OLD.service_principal_id OR
     NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
    RAISE EXCEPTION 'api_key_subject_immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER api_key_terminal_state BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION api_key_terminal_state();
