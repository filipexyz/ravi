# CRM Authorization / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get contacts/crm/authorization --mode rules --json`.
2. Identify every backing contact for the CRM record or projection.
3. Apply contact visibility before returning accounts, opportunities, tasks,
   activities, facts, notes, or next actions.
4. For hidden objects, prefer a missing/not-found shape over disclosing metadata
   in a permission error.
5. Keep writes behind `write_contacts system:*` or a future narrower CRM write
   relation.

## Validation

```bash
bun test src/cli/commands/crm.test.ts src/cli/commands/contacts.test.ts
```
