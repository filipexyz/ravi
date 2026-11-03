-- Reservation remains after an uncertain delivery or revoked executor. Never reassign
-- a bot while an old listener may still run. Confirmed disable is the release barrier.
CREATE TABLE fleet_native_channels (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  installation_id uuid NOT NULL REFERENCES local_installations(id),
  name text NOT NULL,
  team_id text NOT NULL,
  bot_user_id text NOT NULL,
  credential_connection text NOT NULL,
  enabled boolean NOT NULL,
  operation_id uuid NOT NULL REFERENCES fleet_node_operations(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,team_id,bot_user_id),
  UNIQUE (organization_id,installation_id,name)
);
