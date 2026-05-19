# Message And Session Identity Attribution Checks

## Static Checks

- Inbound code resolves sender identity before policy/routing when feasible.
- Group/chat ids are stored as chat targets, not contact actors.
- Message/event records carry actor fields when identity is available.
- Session code does not assume one contact per session.
- Outbound code stores the sending agent/system actor separately from the target chat/contact.
- Contact interaction projections are only updated for resolved contact actors or explicit contact targets.
- Unknown actors preserve raw provenance without creating fake contacts.
- No new code infers identity from display name alone.

Suggested scans:

```bash
rg -n "actor_type|contact_id|agent_id|platform_identity_id|raw_sender_id|normalized_sender_id|identity_confidence|identity_provenance" src/omni src/router src/gateway.ts src/session-trace
rg -n "group_id|last_to|source_chat_id|chatJid|senderPhone|resolvedSenderPhone|displayName.*contact|name.*identity" src
```

## Required Tests

### Inbound DM Known Contact

Given:

- a DM message arrives from a platform identity linked to a contact

Expected:

- message metadata stores `actor_type='contact'`
- message metadata stores `contact_id` and `platform_identity_id`
- session participant is updated for that contact
- contact `last_inbound_at` and interaction count update

### Inbound Group Known Sender

Given:

- a group message arrives from a sender linked to a contact

Expected:

- chat target is the group chat
- sender actor is the contact
- no group-as-contact record is created
- only the sender contact interaction projection is updated

### Inbound Group Unknown Sender

Given:

- a group message arrives from an unresolved sender

Expected:

- actor is stored as `unknown`
- raw sender/chat/message ids are preserved
- no fake contact is created
- chat participant may be unresolved until identity evidence improves

### Outbound Agent Message

Given:

- a Ravi agent sends a message

Expected:

- message metadata stores `actor_type='agent'`
- `agent_id` is present
- agent-owned `platform_identity_id` is present when known
- receiving chat/contact target is stored separately from sender actor

### Multi-Contact Session

Given:

- two contacts speak in the same chat/session

Expected:

- session participants include both contacts
- each message stores its own actor
- `primary_contact_id`, if present, does not overwrite per-message actor identity

### Permission Context

Given:

- a personal/contact-scoped tool is invoked from a session

Expected:

- permission checks use structured active actor context
- prompt text or display name is not used as identity proof
- ambiguous multi-contact contexts require an explicit target

## Smoke Commands

```bash
bun test src/omni/consumer-context.test.ts src/gateway-session-trace.test.ts
bun run build
```

Add narrower tests near the implementation files when storage or routing code changes.

## Acceptance Gate

Implementation is not complete until:

- inbound DM, inbound group, outbound agent, unknown sender, and multi-contact session scenarios are covered by tests
- message/session traces can explain resolved actor and raw provenance
- contact timelines can link back to message/session/chat provenance for meaningful events
- no identity-sensitive code depends on raw provider ids when structured actor metadata is available
