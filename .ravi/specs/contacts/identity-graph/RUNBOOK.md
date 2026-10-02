# Contact Identity Graph / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get contacts/identity-graph --mode rules --json`.
2. Resolve the identifier the way the runtime does: `ravi contacts get
   <phone-or-id> --json` returns the canonical contact for any linked
   identity.
3. If two identifiers of one person resolve to different contacts, check the
   evidence: a WhatsApp LID links to a phone only through a trusted mapping
   (the WhatsApp runner's Baileys LID mapping, or the legacy Omni
   `chat_id_mappings` for old data). Merge explicitly when the evidence is an
   operator decision.
4. If a group or an agent shows up as a contact, treat it as a bug in the
   inbound path (`src/channels/inbound/pipeline.ts`): groups belong in chats
   and agent accounts in agent-owned platform identities.
5. For an inbound message without actor metadata, inspect the message metadata
   for `platform_identity_id` and `contact_id`/`agent_id` and fix the
   resolution path, not the raw id in routing code.

## Validation

```bash
bun test src/contacts.identity-model.test.ts
```
