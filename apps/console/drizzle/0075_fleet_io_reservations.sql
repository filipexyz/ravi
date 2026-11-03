-- Local coordination only: no secret, request body or provider response.
CREATE TABLE fleet_io_reservations (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  input_hash text NOT NULL,
  lease_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, operation_id)
);
