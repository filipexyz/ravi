---
id: contacts/identity-graph/message-session-attribution
title: Message And Session Identity Attribution
kind: feature
domain: contacts
capability: identity-graph
feature: message-session-attribution
tags:
  - contacts
  - identity-graph
  - messages
  - sessions
  - actors
applies_to:
  - src/omni/consumer.ts
  - src/gateway.ts
  - src/router
  - src/session-trace
  - src/triggers
owners:
  - ravi-dev
status: draft
normative: true
---

# Message And Session Identity Attribution

## Intent

Ravi MUST associate messages, session events, and runtime sessions with identities whenever feasible.

Identity attribution connects transport events to canonical Ravi actors without making raw provider ids, chats, or sessions the source of truth.

The target shape is:

```text
message/event
  -> actor metadata
  -> platform_identity
  -> contact | agent

session
  -> chat
  -> session_participant[]
  -> platform_identity
  -> contact | agent
```

## Boundaries

- A raw channel id MUST be stored as provenance, not treated as product identity.
- A chat, group, room, thread, or DM MUST be modeled as a `chat`, not as a `contact`.
- A Ravi session MUST be treated as an agent runtime container bound to a chat. It MUST NOT be treated as a person, group, or identity source of truth.
- `chat_participants` owns canonical chat membership. `session_participants` is only the runtime subset observed by a Ravi session.
- Unknown or unresolved actors are allowed, but they MUST be explicit: `actor_type='unknown'` with raw provenance.
- Display names, profile names, avatars, and prompt text MUST NOT be sufficient evidence for automatic contact identity attribution.
- Agent-owned platform identities MUST resolve to `actor_type='agent'`, not to human contacts.

## Required Actor Metadata

Every persisted inbound/outbound message, session event, and durable runtime event SHOULD include this actor metadata when the data is known:

- `actor_type`: `contact`, `agent`, `system`, or `unknown`
- `contact_id`: set only when the actor is a resolved contact
- `agent_id`: set only when the actor is a resolved agent
- `platform_identity_id`: set when the platform sender/account identity is known
- `chat_id` or `canonical_chat_id`: canonical Ravi chat/conversation id when known
- `session_key`: Ravi runtime session key when the event belongs to a session
- `raw_sender_id`: raw provider sender id as received
- `normalized_sender_id`: normalized provider sender id used for lookup
- `source_channel`: provider/channel name such as `whatsapp`, `telegram`, `email`, or `phone`
- `source_account_id`: channel instance/account id when available
- `source_chat_id`: raw provider chat/thread/group id when available
- `source_message_id`: raw provider message id when available
- `source_thread_id`: raw provider thread id when available
- `identity_confidence`: numeric or enum confidence for the resolved identity
- `identity_provenance_json`: evidence that explains how the identity was resolved
- `observed_at` or `created_at`

Implementations MAY add storage-specific columns, but they MUST preserve enough information to reconstruct who spoke, where they spoke, and what evidence was used.

## Inbound Flow

Inbound message handling MUST resolve identity before policy, routing, and runtime side effects whenever feasible.

Expected flow:

```text
raw inbound event
  -> persist raw transport provenance
  -> normalize/upsert chat
  -> normalize sender identity
  -> resolve/upsert platform_identity when possible
  -> resolve owner contact or agent when evidence is strong enough
  -> persist message metadata with actor fields
  -> upsert chat_participant
  -> resolve route and session
  -> bind session to chat
  -> upsert session_participant
  -> persist session event with actor fields
  -> update contact interaction projections when a contact is resolved
  -> emit contact timeline event only for meaningful contact context
```

For group or shared-chat inbound messages:

- The group id MUST resolve to a chat target.
- The sender id SHOULD resolve to a participant platform identity.
- The sender actor and chat target MUST be stored separately.
- A group message MUST NOT update a contact unless the actual sender, mention target, reply target, or explicit command target resolves to that contact.

## Outbound Flow

Outbound handling MUST distinguish the actor sending the message from the chat or contact being targeted.

Expected outbound rules:

- Ravi-originated outbound messages SHOULD persist `actor_type='agent'` and `agent_id` when an agent sends the message.
- System-originated outbound messages SHOULD persist `actor_type='system'`.
- If the sending agent has a platform account identity, the message SHOULD persist the agent-owned `platform_identity_id`.
- In a DM, the target SHOULD resolve to the contact/platform identity on the receiving side when known.
- In a group, the target is the chat. Mentioned contacts, reply targets, or explicit recipients MUST be represented separately from the chat target.
- Outbound contact interaction projections SHOULD update only when a target contact is explicitly resolved.

## Sessions

Session identity context MUST be derived from structured actor metadata, `chat_participants`, and `session_participants`.

Rules:

- A session MAY expose `primary_contact_id` only as a convenience for simple DMs.
- `primary_contact_id` MUST NOT replace per-message actor metadata.
- A session MAY contain multiple contacts, agents, systems, and unknown actors.
- `session_participants` MUST be updated from observed runtime activity, not from assumed one-human-per-session semantics.
- Tool permission checks that depend on "who is speaking" SHOULD use an explicit active actor context derived from the latest resolved actor/floor state.
- Tool permission checks MUST NOT parse raw prompt text or session names to infer identity when structured actor metadata is available.

## Interaction Projections

Contact interaction projections such as `last_inbound_at`, `last_outbound_at`, and `interaction_count` MUST only update when an actual contact actor or explicit contact target is resolved.

Rules:

- Inbound one-to-one message from a resolved contact SHOULD update `last_inbound_at` and interaction count for that contact.
- Inbound group message SHOULD update the sender contact only when the sender resolves to a contact.
- Outbound DM to a resolved contact SHOULD update `last_outbound_at` for that contact.
- Outbound group message MUST NOT update all group participants.
- Unknown actors MUST NOT create fake contacts or mutate contact projections.

## Contact Timeline Integration

`contact_events` records MAY reference messages, chats, sessions, and platform identities as provenance.

Rules:

- A contact timeline event MUST have a resolved `contact_id`.
- A timeline event MAY reference `message_id`, `chat_id`, `session_key`, `platform_identity_id`, `source_message_id`, or other provenance.
- Not every message should become a contact timeline event.
- Timeline events SHOULD be created for durable context such as confirmed facts, proposals, summaries, policy changes, meaningful interactions, or audit events.
- Timeline events derived from session/message observations MUST preserve actor metadata and scope.

## Privacy And Permissions

Identity attribution increases the sensitivity of message/session metadata.

Rules:

- Reads of message/session actor metadata MUST respect contact, chat, and session permissions.
- Broad streams or admin views SHOULD redact raw provider ids unless the caller has diagnostic permission.
- Trigger subscriptions that expose contact identity MUST apply the same authorization model as contact timeline reads.
- Unknown actor records SHOULD preserve raw provenance for diagnostics, but product surfaces SHOULD minimize it by default.

## Legacy Removal Register

These legacy or compatibility surfaces are not target architecture:

| Legacy surface | Target replacement | Removal condition |
| --- | --- | --- |
| `message_metadata.chat_id` without actor ids | message metadata with actor fields and chat target | all message reads can distinguish speaker from chat |
| `session_events.source_chat_id` only | session event actor fields plus raw provenance | session traces can show resolved actor and raw source |
| `sessions.group_id` as identity | explicit chat binding plus participants | sessions bind to canonical chats |
| `sessions.last_to` as implicit contact | explicit outbound target metadata | outbound target is represented as chat/contact/platform identity |
| `session.primary_contact_id` as truth | convenience field only | all identity-sensitive code uses actor metadata or participants |
| raw WhatsApp JID/LID in prompts as identity | structured actor metadata and provenance | tools receive active actor context |
| group-as-contact records | canonical chats and chat participants | no new group contacts are created and migrated groups have a removal path |

## Acceptance Criteria

- New inbound messages preserve resolved `contact_id`, `agent_id`, and/or `platform_identity_id` when available.
- Unknown inbound actors persist as `actor_type='unknown'` with raw provenance instead of fake contacts.
- Outbound messages preserve the Ravi agent/system actor separately from the receiving chat or contact target.
- Group messages store the chat target and sender actor separately.
- `chat_participants` represents canonical chat membership, while `session_participants` represents observed runtime participation.
- A DM session may expose `primary_contact_id`, but message actor metadata remains authoritative.
- Contact interaction projections update only for resolved contact actors or explicit contact targets.
- Contact timeline entries can link back to message/session/chat/platform provenance.
- Permission checks can use structured active actor context without parsing prompts or raw provider ids.
