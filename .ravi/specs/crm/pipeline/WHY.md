# CRM Pipeline Canonical Metadata Schema / WHY

`pipeline.metadata` used to be free-form, which let engines invent keys and
drift independently. Dispatcher gates, preconditions, TTL sweep, VIP guard,
send-window validation, and tag engines need one schema they can tolerate and
explain.

The schema is intentionally backward-compatible: unknown keys are preserved,
all documented fields are optional unless their parent object is present, and
consumers fail open for unknown precondition types or missing derivation data.
