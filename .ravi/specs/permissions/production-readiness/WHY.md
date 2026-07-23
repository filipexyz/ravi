# Permissions Production Readiness / WHY

Permissions are production ready only when automated checks prevent regression
against the live model: turn-scoped agent identity authority, explicit
provenance, fail-closed unresolved actors, and provider-owned runtime
capabilities.

This spec is the exit checklist. It turns "seems secure" into concrete gates for
cross-evaluator agreement, core unit coverage, recovery paths, reconciliation,
and doctor health.
