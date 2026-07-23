# CRM Domain / RUNBOOK

## Debug Flow

1. Read the umbrella:
   `ravi specs get crm --mode rules --json`.
2. If the change touches pipeline metadata, read `crm/pipeline`.
3. If the change exposes contacts or relationship data, read
   `contacts/authorization` and `contacts/crm/authorization`.
4. Do not use the current domain-level placeholder as enough approval for a
   runtime/API behavior change.
5. Before relying on this domain as normative, replace placeholder intent,
   invariants, validation, and failure modes with concrete CRM rules.

## Validation

```bash
bun test src/cli/commands/crm.test.ts src/crm/pipeline-metadata.test.ts src/crm/pipeline-engines.test.ts
```
