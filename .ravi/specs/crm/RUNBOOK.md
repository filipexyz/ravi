# CRM Domain / RUNBOOK

## Debug Flow

1. Read `ravi specs get crm --mode rules --json` before changing CRM behavior.
2. For a facade change, create a plan first. Confirm its resolved target and
   expiry before requesting approval.
3. Use `crm facade approve` with the real external destination. Do not treat a
   plan hash printed by the CLI as an approval by itself.
4. Run `crm facade apply` once. If its state is `unknown`, use
   `crm facade recover` and inspect the real CRM record; do not replay it.
5. If the change touches pipeline metadata, also read `crm/pipeline`. If it
   exposes relationship data, read `contacts/authorization` and
   `contacts/crm/authorization`.

## Validation

```bash
bun test src/cli/commands/crm.test.ts src/crm/facade.test.ts src/crm/pipeline-metadata.test.ts src/crm/pipeline-engines.test.ts
```
