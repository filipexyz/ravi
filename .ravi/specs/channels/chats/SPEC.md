---
id: channels/chats
title: Chat Model
kind: capability
domain: channels
capability: chats
tags:
  - channels
  - chats
  - sessions
  - participants
  - omni
applies_to:
  - src/omni/consumer.ts
  - src/router/sessions.ts
  - src/router/resolver.ts
  - src/contacts.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Chat Model

## Intent

Ravi needs a first-class chat model to abstract channel conversations received from Omni.

A chat is the conversation container from the channel. A session is the runtime state of one Ravi agent working inside or about that chat.

This distinction is required because the same chat can be handled by multiple agents, and each agent can have its own session/state/history for that same chat.

## Definitions

- `chat`: channel conversation container such as WhatsApp DM, WhatsApp group, Telegram chat, room, or thread.
- `chat_participant`: actor membership/participation inside a chat, resolved through platform identity when possible.
- `session`: runtime state for a specific Ravi agent, route, or workflow bound to a chat.
- `session_participant`: actor observed in a specific runtime session. This is not the canonical membership list.
- `actor`: who produced a message/event: contact, agent, system, or unknown.

## Core Rule

Participants belong primarily to `chat`.

`session_participants` MAY exist, but only to represent who participated in that agent runtime session. It MUST NOT replace `chat_participants`.

## Chat To Session Relationship

One chat MAY have many sessions.

Examples:

- the same WhatsApp group can have `main`, `webmaster`, and `support` agent sessions.
- a DM can have one normal agent session and another specialized follow-up/calls session.
- a thread can become a distinct session while still belonging to the same underlying chat.

A session SHOULD reference its chat through a stable `chat_id` or equivalent binding.

A session name/key MUST NOT be treated as the chat identity.

## Data Model

### `chats`

Fields:

- `id`
- `channel`
- `instance_id`
- `platform_chat_id`
- `normalized_chat_id`
- `chat_type`: `dm`, `group`, `room`, `thread`, or future type
- `title`
- `avatar_url`
- `metadata_json`
- `raw_provenance_json`
- `first_seen_at`
- `last_seen_at`
- `created_at`
- `updated_at`

Constraints:

- `channel + instance_id + normalized_chat_id` SHOULD be unique.
- Raw provider ids MUST be preserved as provenance.
- A chat MUST NOT be modeled as a contact/person.

### `chat_participants`

Fields:

- `chat_id`
- `platform_identity_id`
- `contact_id`
- `agent_id`
- `role`: `member`, `admin`, `owner`, `agent`, `unknown`, or future role
- `status`: `active`, `left`, `removed`, `unknown`
- `source`: `omni`, `inbound_message`, `manual`, `import`, or future source
- `first_seen_at`
- `last_seen_at`
- `metadata_json`

Constraints:

- `chat_id + platform_identity_id` SHOULD be unique when `platform_identity_id` is known.
- `contact_id` and `agent_id` are denormalized convenience fields derived from platform identity ownership.
- Participant rows MUST tolerate unresolved actors.

### `session_chat_bindings`

This MAY be a dedicated table or fields on `sessions`.

Fields:

- `session_key`
- `chat_id`
- `agent_id`
- `route_id`
- `binding_reason`
- `created_at`
- `updated_at`

The binding records which chat a runtime session belongs to. It does not define who participates in the chat.

## Migration From Current Ravi State

Current Ravi already has partial chat data, but it is not canonical.

Migration SHOULD treat these as source data:

- `sessions.channel`, `sessions.account_id`, `sessions.group_id`, `sessions.last_channel`, `sessions.last_account_id`, `sessions.last_to`, and `sessions.last_thread_id`
- `message_metadata.chat_id`
- `session_events.source_channel`, `source_account_id`, `source_chat_id`, and `source_thread_id`
- `omni_group_metadata` and its `participants_json`
- `account_pending.chat_id`, `account_pending.phone`, and `account_pending.is_group`

Migration SHOULD move or project this data into:

- `chats`
- `chat_participants`
- `session_chat_bindings` or equivalent fields on `sessions`
- per-message/per-event chat and actor metadata

`omni_group_metadata` MAY remain as a raw transport cache, but it MUST NOT be the only place Ravi stores group participants.

`account_pending` SHOULD stop treating a group as a pending contact. Pending group/chat state belongs to chat/routing review; pending human state belongs to contact review.

## Legacy Removal Register

These legacy surfaces MUST be removed, split, or reduced to explicit compatibility/cache roles:

| Legacy surface | Target replacement | Removal condition |
| --- | --- | --- |
| group identity stored as contact | `chats` | all route/policy/session flows resolve group by chat |
| `omni_group_metadata.participants_json` as participant source of truth | `chat_participants` | group participants are queryable from Ravi chat model |
| `account_pending.is_group` sharing pending-contact semantics | pending chat/route review backed by `chats` | pending humans and pending chats have separate flows; chat approval creates route review state without creating contacts |
| `sessions.group_id` as implicit chat identity | `session_chat_bindings.chat_id` or explicit `sessions.chat_id` | sessions bind to canonical chat id |
| `sessions.last_to`/`last_channel`/`last_account_id` as only outbound target memory | explicit chat binding + last target provenance | gateway/outbound can resolve via chat binding |
| `message_metadata.chat_id` without canonical chat/actor ids | message metadata with `chat_id`, `actor_type`, `platform_identity_id`, `contact_id`, `agent_id` | reply/media reinjection can use canonical chat + actor metadata |
| `session_events.source_chat_id` without canonical chat/actor ids | session events with canonical chat and actor metadata | traces can show semantic actor while preserving raw source ids |

## Inbound Flow

Expected flow:

```text
Omni raw inbound
  -> normalize chat id
  -> upsert chat
  -> normalize sender id
  -> resolve/upsert platform identity
  -> upsert chat_participant
  -> resolve route/session for target agent
  -> bind session to chat
  -> persist message/event actor metadata
```

Route resolution MAY still use raw ids for compatibility, but resolved chat/contact/actor metadata SHOULD be persisted with the resulting session and events.

## Group Chats

For group messages:

- the group id resolves to `chat`
- the sender resolves to `platform_identity` and then contact/agent when possible
- known group members SHOULD populate `chat_participants`
- the group MUST NOT be represented as a human contact

## Direct Messages

For DMs:

- the DM resolves to `chat`
- the remote human resolves to contact/platform identity when possible
- the assigned Ravi agent resolves to agent/platform identity when possible
- the session MAY expose `primary_contact_id` for convenience, but message actors remain authoritative

## Channel Capabilities

Channel capabilities are not required to implement the chat model.

Omni SHOULD remain the source of transport capability facts when Ravi needs to know whether a channel supports stickers, calls, presence, reactions, or future behaviors.

Do not introduce a large capability registry for this work unless a concrete feature needs it. The chat/participant model should not be blocked by channel capabilities.

## Acceptance Criteria

- The same chat can be bound to multiple agent sessions.
- Chat participants are stored at chat level, not only at session level.
- Session participants do not overwrite chat participants.
- A WhatsApp group is a chat, not a contact.
- Each message/event can preserve the actor that produced it.
- Diagnostics can still recover raw Omni ids for chat, sender, and message.
