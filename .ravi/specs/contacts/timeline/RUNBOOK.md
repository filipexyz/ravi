# Contact Timeline Runbook

## Before Implementation

Read the required contact/channel specs:

```bash
bin/ravi specs get channels --mode rules --json
bin/ravi specs get channels/chats --mode rules --json
bin/ravi specs get contacts --mode rules --json
bin/ravi specs get contacts/identity-graph --mode rules --json
bin/ravi specs get contacts/identity-graph/unified-model --mode rules --json
bin/ravi specs get contacts/timeline --mode rules --json
```

Inspect current mutation surfaces:

```bash
rg -n "updateContact|addContactTag|removeContactTag|mergeContactNotes|linkContactIdentity|unlinkContactIdentity|mergeContacts|setContactStatus|setOptOut" src/contacts.ts src/cli/commands/contacts.ts
```

Inspect current actor/event metadata:

```bash
rg -n "actor_type|contact_id|platform_identity_id|identity_provenance|session_events|message_metadata" src/router src/omni src/session-trace
```

## Implementation Order

1. Add `contact_events` storage and typed service functions.
2. Add a single helper for writing contact events transactionally with state mutations.
3. Emit events from existing contact mutations: status, reply mode, opt-out, tags, notes, metadata, link, unlink, merge.
4. Add `ravi contacts timeline <contact> --json`.
5. Emit normalized NATS events for contact timeline entries.
6. Add permission checks before exposing timeline reads/subscriptions broadly.
7. Add agent-produced proposal events only after human/operator mutations are audited.

## Event Write Rules

For a state-changing command:

1. Resolve the target into canonical `contact_id`.
2. Determine `scope_type` and `scope_id`; use `global` only when the fact is universally true about the contact.
3. Resolve actor metadata when available.
4. Mutate current state/projection and insert `contact_events` in the same transaction.
5. Emit NATS event after the transaction commits.
6. If event emit fails, keep the durable DB event and allow retry/replay.

Do not emit an event without a durable ledger row for important contact state changes.

## Debugging

When a contact's context looks wrong:

1. Run `ravi contacts get <contact> --json`.
2. Run `ravi contacts timeline <contact> --json`.
3. Check whether the unexpected current value has a corresponding event.
4. Inspect `scope_type` and `scope_id` first. Many apparent conflicts are valid in different scopes.
5. Inspect `source`, `actor_type`, `actor_id`, `confidence`, and `evidence`.
6. If the bad change came from an agent proposal, verify whether it was incorrectly promoted to confirmed state.

## Backfill

Existing contacts may be backfilled with synthetic migration events:

- `profile.metadata_set` for existing metadata/notes when useful
- `profile.tag_added` for current tags
- `policy.status_changed` with `source=migration`
- `identity.linked` for current platform identities when not already represented by `identity_link_events`

Backfill events MUST use `source=migration` and evidence that identifies the legacy table/field.

## Scope Selection

Use these defaults:

- global: canonical identity/profile facts and durable preferences
- domain: CRM/support/personal status or lifecycle fields
- project: project role, project sentiment, project next action
- chat: group role, group label, chat-specific participant metadata
- session: temporary runtime observations
- org: relationship between a person and an organization
- task: task-specific context or temporary assignment facts
- agent: agent-specific memory or profile

Do not store chat/group labels as global tags.
