# CRM Domain / CHECKS

## Checks

- `ravi specs get crm --mode rules --json` MUST return the CRM domain spec.
- Any CRM runtime or API change MUST identify the concrete child spec that owns
  behavior before implementation.
- Contact-linked CRM reads MUST pass the contact and CRM authorization checks.
- Pipeline metadata changes MUST pass `crm/pipeline` validation.
- `bun test src/cli/commands/crm.test.ts src/crm/pipeline-metadata.test.ts src/crm/pipeline-engines.test.ts`
  SHOULD pass after CRM domain changes.
