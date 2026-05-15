# Unified Contacts Model Runbook

## Before Implementation

1. Inspect current contact schema and migrations:

```bash
rg -n "account_pending|allowed_agents|platform_identities|contact_policies" src/contacts.ts src/cli/commands/contacts.ts
```

2. Inspect current inbound identity usage:

```bash
rg -n "getContact|savePendingContact|recordInbound|senderPhone|resolvedSenderPhone|chatJid|stripJid" src/omni src/router src/gateway.ts
```

3. Inspect current CLI aliases:

```bash
bun src/cli/index.ts contacts --help
bun src/cli/index.ts contacts list --json
```

4. Compare Omni identity concepts before finalizing names:

```bash
rg -n "persons|platformIdentities|chatIdMappings|chatParticipants|canonicalId" /Users/luis/dev/namastex/omni-v2/packages/db/src/schema.ts
```

## Implementation Order

1. Add new tables or migration columns behind the existing contacts service.
2. Add typed service functions for platform identity lookup, link, unlink, merge, and duplicate detection.
3. Import old contact-like data through an explicit one-time migration if needed.
4. Resolve `getContact(<ref>)` through canonical contacts and platform identities.
5. Update inbound handling to upsert/resolve platform identities before policy checks.
6. Update CLI output to show contact, identities, policy, and duplicate candidates.
7. Update traces/events/message metadata to include resolved ids where available.
8. Add regression tests for canonical-only read/write paths.

## Import Safety

Run imports in dry-run mode first if possible.

Import must report:

- total source contacts
- total source identities
- created contacts
- created platform identities
- group-like identities requiring chat migration
- duplicate candidates
- rejected/invalid identities

Do not add runtime reads to old stores; import into canonical tables instead.

## Debugging Identity Resolution

When a message routes incorrectly:

1. Start from raw inbound metadata: channel, instance, chat id, sender id, resolved sender id.
2. Resolve `platform_identity` by `channel + instance_id + normalized_platform_user_id`.
3. Confirm owner type: contact or agent.
4. Confirm contact policy if owner is contact.
5. Only then inspect routes/sessions.

Do not debug identity by reading session names first. Session names are derived runtime state, not identity truth.

## Operator-Facing Checks

Useful commands after implementation:

```bash
ravi contacts get <phone-or-whatsapp-identity> --json
ravi contacts duplicates --json
ravi contacts merge <source> <target> --reason "same person confirmed"
ravi contacts link <contact> --channel whatsapp --id "<provider-whatsapp-id>" --reason "provider identity mapping"
```

## Rollback

If inbound identity resolution breaks:

1. Disable new resolver via feature flag if available.
2. Keep `getContact` resolving through canonical contacts and platform identities.
3. Do not delete new tables; mark records as inactive only if necessary.
4. Re-run migration after fixing normalization.
