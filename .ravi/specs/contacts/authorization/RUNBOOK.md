# Contact Authorization / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get contacts/authorization --mode rules --json`.
2. Identify whether the caller is runtime context or direct local operator CLI.
3. For runtime reads, call `canAccessContact` or the current equivalent helper.
4. Verify the grant type: `read_own_contacts`, `read_tagged_contacts`,
   `read_contact`, or `write_contacts`.
5. Confirm raw phone/LID/JID/email lookup resolves to canonical contact
   authorization before returning data.
6. Hidden contacts should appear missing on direct lookup.

## Validation

```bash
bun test src/cli/commands/contacts.test.ts src/contacts.identity-model.test.ts
```
