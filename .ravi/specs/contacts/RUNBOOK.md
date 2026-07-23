# Contacts / RUNBOOK

## Debug Flow

1. Read the inherited rules:
   `ravi specs get contacts --mode rules --json`.
2. Resolve raw channel identifiers into `platform_identity` scoped by channel
   and instance.
3. Resolve the platform identity owner to contact or agent. Do not infer a
   contact from display name alone.
4. Apply contact policy only after identity resolution; policy status is not
   Permission Provider Runtime authority.
5. For groups, rooms, and threads, switch to `channels/chats`; do not create a
   person contact.
6. For reads, verify contact authorization before lookup, search, timeline, or
   CRM projection output.

## Validation

```bash
bun test src/contacts.identity-model.test.ts src/cli/commands/contacts.test.ts
```
