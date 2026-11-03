-- A historic review checklist is not proof of a live outbound installation.
ALTER TABLE fleet_onboarding ADD COLUMN flow_version integer NOT NULL DEFAULT 1;
