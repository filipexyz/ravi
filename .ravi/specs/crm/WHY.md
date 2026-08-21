# CRM / WHY

## Rationale

CRM spans durable records, pipeline configuration, controlled effects, contact
visibility, and the command surface used by agents. Treating one concern as the
whole domain makes rules hard to find and lets unrelated behavior drift.

The `crm` spec is the cross-cutting map, not a replacement for the established
contact-anchored contracts. Data, projections, and audit remain in
`contacts/crm`; pipeline topology remains in `contacts/crm/pipelines`. Narrow
metadata and controlled-effect rules live in `crm/pipeline` and `crm/facade`,
while `cli/crm` owns the command interface. Contact disclosure remains governed
by `contacts/authorization` and `contacts/crm/authorization`.

This separation lets an agent load the smallest complete rule set without
mistaking one execution path for the entire CRM domain.
