# CRM / CHECKS

## Checks

- `ravi specs get crm --mode rules --json` MUST return this umbrella.
- Every CRM change MUST identify and satisfy all applicable owning specs.
- Relationships MUST reject unresolved and wrong-kind references before
  persistence.
- Data-model, event, projection, and audit changes MUST satisfy `contacts/crm`.
- Pipeline and stage topology, movement, and configuration-audit changes MUST
  satisfy `contacts/crm/pipelines`.
- Contact-linked reads and writes MUST pass the applicable contact
  authorization checks before disclosure or mutation.
- Pipeline changes MUST satisfy `crm/pipeline`.
- Controlled-effect changes MUST satisfy `crm/facade`.
- CRM interface, discovery, and error changes MUST satisfy `cli/crm`.
- Focused checks from every affected child SHOULD pass before merge.
