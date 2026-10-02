# Mentioned Contact Context / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get contacts/routing-context/mentioned-contact-context --mode rules --json`.
2. Confirm the inbound message carried formal mention metadata (WhatsApp
   `mentionedJids` / `mentionedContacts`); display-name text alone never
   produces context.
3. Confirm the mentioned id resolves to a platform identity owned by a
   contact (`ravi contacts get <id> --json`). Unresolved, ambiguous and
   agent-owned identities are omitted by design.
4. Inspect the prompt payload for `mentionedContactsContext`; the rendered user
   prompt must not contain the CRM lines.

## Validation

```bash
bun test src/channels/inbound/pipeline-context.test.ts src/prompt-builder.test.ts src/channels/mentions.test.ts
```
