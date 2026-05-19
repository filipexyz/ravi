# Inbound Contact Intake Checks

## Static Checks

- No inbound DM path should return for no-route/pending before chat/message/contact intake when intake is enabled.
- No code should create a contact whose identity is a WhatsApp group JID or group chat id.
- No code should create a CRM contact table separate from canonical `contacts`.
- New automatic writes should target canonical `contacts`, `platform_identities`, `contact_policies`, and audit events only.
- Automatic intake should not reset `blocked`, `allowed`, or `opt_out` policy state.
- `message_metadata` should not be described as the durable conversation ledger.

Suggested scans:

```bash
rg -n "saveAccountPending|No route|contact_intake|ensureContactFromInbound|crm_contact_profiles|message_metadata|@g\\.us" src
```

## Runtime Tests

### New Human DM Without Route

Given:

- instance has `contact_intake_mode='discovered'`
- inbound WhatsApp DM arrives
- no route exists for that chat

Expected:

- canonical chat exists
- durable message record exists
- canonical contact exists
- platform identity exists with channel and instance
- contact policy status is `discovered`
- pending route/chat state may exist separately
- no CRM enrichment is required

### Idempotent Redelivery

Given:

- the same provider message/event is delivered twice

Expected:

- one durable message record
- one platform identity for the normalized sender
- one contact or same existing linked contact
- no duplicate contact from display/profile fields

### Existing Blocked Contact

Given:

- sender already resolves to a contact with `contact_policies.status='blocked'` or `opt_out=1`

Expected:

- intake updates `last_seen`/provenance
- policy remains blocked/opted-out
- no automatic reply permission is granted

### Group Message

Given:

- inbound WhatsApp group message

Expected:

- group resolves to chat
- sender may resolve to contact/platform identity
- group JID is not stored as contact identity
- group role/labels stay scoped to chat participant context

### CRM Deferred

Given:

- inbound contact is created automatically

Expected:

- `crm_contact_profiles` may be absent or `lifecycle='unknown'`
- no facts, opportunities, or activities are required for contact capture
- later observer/CRM analysis can enrich with provenance

## CLI/API Checks

Expected public behavior:

```bash
ravi contacts list --json
ravi contacts get <phone-or-platform-id> --json
```

The returned object SHOULD expose:

- `contact`
- `platformIdentities`
- `policy`
- `timeline` or event provenance when requested
- pending/contact status separate from route/chat pending

## Canonical Runtime Gate

Do not accept a runtime contact path unless:

- automatically discovered contacts are readable from `ravi contacts`
- policy values are preserved
- no group ids appear as human contacts
- pending chat/route and pending contact lists are separated
- durable message storage exists for inbound messages that do not reach an agent
