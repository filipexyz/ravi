---
id: contacts/identity-graph
title: Contact Identity Graph
kind: capability
domain: contacts
capability: identity-graph
tags:
  - contacts
  - identity-graph
  - platform-identities
applies_to:
  - src/contacts.ts
  - src/omni/consumer.ts
  - src/router/sessions.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Contact Identity Graph

## Intent

The contact identity graph is the canonical layer that maps platform-specific identifiers to Ravi contacts and agents.

Its purpose is to let Ravi know that multiple identifiers can represent the same actor while keeping contacts, agents, groups, routing, and policy semantically separate.

## Required Shape

The identity graph MUST support these owner classes:

- `contact`: a canonical person or organization.
- `agent`: a Ravi agent that appears on a communication platform.

It MUST support these non-owner relationships:

- `chat`: a DM, group, room, thread, or platform conversation.
- `chat_participant`: a platform identity participating in a chat.
- `session_participant`: a resolved contact, agent, or platform identity participating in a Ravi runtime session.

## Platform Identity

`platform_identity` MUST be the durable representation of "how an actor appears on a platform".

Required fields:

- `id`
- `owner_type`: `contact` or `agent`
- `owner_id`
- `channel`: `whatsapp`, `telegram`, `discord`, `email`, `phone`, or future active channel
- `instance_id`
- `platform_user_id`
- `platform_display_name`
- `avatar_url`
- `profile_data`
- `is_primary`
- `confidence`
- `linked_by`: `auto`, `manual`, `phone_match`, `lid_match`, `import`, or `initial`
- `link_reason`
- `first_seen_at`
- `last_seen_at`
- `created_at`
- `updated_at`

`owner_type + owner_id` MUST be exclusive. A platform identity MUST NOT point to both a contact and an agent.

`channel + instance_id + platform_user_id` MUST be unique.

## Contact

`contact` MUST represent a canonical CRM actor, not a platform id.

Required fields:

- `id`
- `kind`: `person` or `org`
- `display_name`
- `primary_phone`
- `primary_email`
- `avatar_url`
- `metadata`
- `created_at`
- `updated_at`

Contacts MAY have policy fields in a related policy table or a clearly separated policy section, but policy fields MUST NOT be used as identity evidence.

## Agent Identity

Ravi agents MUST remain in the agent registry.

When an agent has an account on a channel, that account SHOULD be represented as `platform_identity(owner_type='agent', owner_id=<agent_id>)`.

Agent-owned identities MUST NOT be merged into human contacts.

Legacy channel-specific agent fields SHOULD be migrated into platform identities or removed when the channel is no longer active.

## Groups and Chats

Groups, channels, rooms, and threads MUST be modeled as chats/conversations, not contacts.

Chat participants SHOULD link to platform identities, and from there to contacts or agents when known.

The canonical participant list belongs to `chat_participants`, not `session_participants`.

## Sessions and Actors

A Ravi session is an agent runtime container bound to a chat. It is not a person and not the chat itself.

One chat MAY have multiple Ravi sessions, usually one per agent, route, or workflow.

A session MAY have a `primary_contact_id` only as a convenience for simple DMs. That field MUST NOT be treated as the complete identity model.

Multiple contacts and agents MAY participate in the same session. Their participation SHOULD be represented through `session_participants` and per-message/per-event actor metadata, but the full membership list SHOULD be read from `chat_participants`.

Inbound and outbound messages SHOULD persist actor identity independently:

- `actor_type`: `contact`, `agent`, `system`, or `unknown`
- `contact_id` when actor is a contact
- `agent_id` when actor is an agent
- `platform_identity_id` when a platform identity is known
- raw channel sender identifiers for audit/debugging

Features that need to address a specific human MUST choose an explicit target contact or platform identity instead of assuming the session has only one human.

## Link Confidence

Automatic linking is allowed only with strong evidence.

Strong evidence examples:

- WhatsApp LID to phone mapping from provider state or Omni `chat_id_mappings`.
- Same platform identity already resolved across instances.
- Explicit user/operator action.

Weak evidence examples:

- Same display name.
- Similar avatar.
- Same first name.
- Recent conversation proximity.

Weak evidence MUST create duplicate candidates or suggestions, not automatic merges.

## Merge and Unlink

Merge MUST move all platform identities from the source contact to the target contact and preserve useful profile/policy data.

Merge MUST write an audit event containing source, target, actor, reason, and moved identity ids.

Unlink MUST detach a platform identity from its current owner and either attach it to another owner or leave it as an unresolved identity candidate.

Unlink MUST write an audit event.

## Resolution Contract

All inbound channel messages SHOULD emit or persist enough metadata to reconstruct:

- raw `platform_user_id`
- normalized `platform_user_id`
- `channel`
- `instance_id`
- resolved `platform_identity_id`
- resolved `contact_id` or `agent_id`
- confidence/link provenance

Sessions, routes, tasks, artifacts, calls, and events MAY reference contacts or platform identities, but MUST NOT become the source of truth for identity resolution.
