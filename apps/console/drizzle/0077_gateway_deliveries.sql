-- Delivery metadata only. Private prompts, responses and execution journal stay on Ravi.
CREATE TABLE fleet_gateway_deliveries (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  subject_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  input_digest text NOT NULL,
  origin_kind text NOT NULL CONSTRAINT fleet_gateway_delivery_origin CHECK(origin_kind IN ('browser','channel','automation')),
  origin_id text NOT NULL,
  delivery_id text NOT NULL,
  state text NOT NULL CONSTRAINT fleet_gateway_delivery_state CHECK(state IN ('pending','acknowledged','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,subject_id,operation_id)
);
CREATE UNIQUE INDEX fleet_gateway_delivery_source ON fleet_gateway_deliveries(organization_id,subject_id,installation_id,origin_kind,origin_id,delivery_id);
