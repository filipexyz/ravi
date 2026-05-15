# Unified Contacts Model Checks

## Static Checks

- No new code should treat display name as merge proof.
- No new code should create a human contact for a WhatsApp group JID.
- No new code should merge agent-owned platform identities into contacts.
- Inbound code should resolve platform identity before contact policy where possible.
- Session code should not assume one contact per session.
- Message/event persistence should carry actor metadata when identity is available.
- CLI JSON should expose structured `contact`, `platformIdentities`, and `policy`.

Suggested scans:

```bash
rg -n "displayName.*merge|name.*merge|whatsapp_group|@g\\.us|owner_type|platform_identity|platformIdentities" src
```

## Import Tests

Create fixtures for:

- phone contact
- WhatsApp identity contact
- phone + WhatsApp identity as separate old records
- WhatsApp group record
- Telegram identity
- dead channel identity that should be archived or removed
- contact with tags/notes/allowed agents/opt-out

Expected:

- all non-group identities survive migration
- phone + WhatsApp identity can converge when trusted mapping exists
- group records are not treated as people
- policy data survives
- duplicate candidates are reported when evidence is insufficient

## Runtime Regression Tests

### Phone And WhatsApp Identity Same Person

Given:

- contact A has phone identity
- contact B has WhatsApp platform identity
- trusted Omni mapping links both

Expected:

- resolver returns one canonical contact
- merge/link audit event is written
- `ravi contacts get <phone>` and `ravi contacts get <whatsapp-identity>` return the same contact

### Agent-Owned Identity

Given:

- agent `main` has a WhatsApp or Telegram platform identity

Expected:

- inbound from that identity resolves as `owner_type=agent`
- `ravi contacts add` / contact upsert for that same identity fails instead of creating a shadow human contact
- contact lookup by that same identity returns no human contact unless the platform identity owner is changed through an explicit audited operation
- duplicate detection does not suggest merging it into a contact

### Group Is Chat

Given:

- inbound WhatsApp group message

Expected:

- group id resolves to chat/group context
- participant sender resolves to platform identity/contact when possible
- no new person contact is created for the group itself

### Multi-Contact Session

Given:

- two different contacts send messages in the same group or shared session

Expected:

- the session has two contact participants
- each message/event stores the correct actor contact/platform identity
- outbound/call/task targeting requires an explicit target when ambiguity exists

### Ambiguous Duplicate

Given:

- two contacts share the same display name but no strong identifier

Expected:

- `ravi contacts duplicates` may show low-confidence suggestion
- no automatic merge happens

### Policy Preserved

Given:

- contact is blocked or opted out

Expected:

- identity linking does not reset policy
- inbound/outbound checks still respect block/opt-out

## CLI Smoke

```bash
bun src/cli/index.ts contacts list --json
bun src/cli/index.ts contacts get <known-ref> --json
bun src/cli/index.ts contacts duplicates --json
```

Expected JSON shape:

```json
{
  "contact": {},
  "platformIdentities": [],
  "policy": {},
  "duplicateCandidates": []
}
```

## Acceptance Gate

Implementation is not complete until:

- one person can have multiple channel identities
- agents can own platform identities
- groups are no longer represented as human contacts
- merges are audited
- ambiguous duplicates remain suggestions
- sessions/routes/events can carry resolved identity metadata without becoming identity source of truth
- sessions can represent multiple participating contacts without overwriting actor identity
- every removed runtime surface is absent from contact service read/write paths
