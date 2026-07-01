---
id: channels/chats/reactions
title: Reaction Accounting
kind: capability
domain: channels
capability: reactions
tags:
  - channels
  - chats
  - reactions
  - accounting
  - omni
applies_to:
  - src/omni/consumer.ts
  - src/router/router-db.ts
  - src/sdk/gateway/streaming/channels.ts
  - src/triggers/topic-catalog.ts
  - src/approval/service.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Reaction Accounting

## Intent

Inbound emoji reactions received from channels MUST be durably accounted for in Ravi storage so that reaction history is queryable, auditable, and survives daemon restarts. Without durable accounting, reactions exist only as ephemeral NATS events and are lost once consumed.

## Storage Decision

Reactions are persisted as rows in `chat_messages` with `message_type = 'reaction'`.

Rationale:

- `chat_messages` already holds the per-chat message ledger with actor metadata, provenance, timestamps, and idempotency via the `(channel, instance_id, chat_id, provider_message_id)` unique constraint.
- Reactions are logically messages in the chat ledger: they have a sender, a target, a timestamp, and belong to a chat.
- A separate entity would duplicate schema, indexes, and query patterns without meaningful benefit.
- `session_events` is a runtime trace surface, not a durable chat-level ledger. Reactions are chat-level accounting.

## Invariants

- Reaction accounting MUST be durable and idempotent.
- The dedupe key MUST account for `targetMessageId + emoji + senderId`. The deterministic `provider_message_id` for a reaction row is `reaction:{targetMessageId}:{emoji}:{senderId}`.
- Reactions MUST be persisted in `chat_messages` with `message_type = 'reaction'`.
- The `content_json` for a reaction row MUST contain at least `{ type: "reaction", targetMessageId, emoji, senderId }`.
- The `raw_provenance_json` MUST preserve raw event metadata: event id, subject, channel type, instance id, chat id, and sender/from data when resolvable.
- `ravi.inbound.reaction` MUST remain the canonical trigger/approval correlation event with the current compatibility payload `{ targetMessageId, emoji, senderId }`.
- Inbound reactions MUST NOT enter the `message.received` dispatch path. They MUST NOT create user prompts or runtime turns.
- The `message.received` handler MUST continue to skip `content.type = "reaction"` payloads.
- The reaction handler MUST resolve the chat for the reaction using the `chatId` from the reaction payload and the instance/channel from the NATS subject.
- When the chat cannot be resolved (unknown instance, missing chat), the reaction MUST still emit `ravi.inbound.reaction` for backward compatibility but MAY skip durable accounting with a logged warning.
- Duplicate events with the same `targetMessageId + emoji + senderId` within the same `(channel, instance_id, chat_id)` scope MUST NOT create duplicate rows.
- The in-memory dedupe set in the consumer is a performance optimization only. The durable idempotency guarantee comes from the `UNIQUE(channel, instance_id, chat_id, provider_message_id)` constraint in `chat_messages`.
- Reactions MUST NOT modify the target message row in `chat_messages`. The reaction is a separate ledger entry.

## Data Model

### Reaction row in `chat_messages`

| Field | Value |
| --- | --- |
| `chat_id` | Canonical chat id resolved from reaction `chatId` + instance |
| `channel` | Normalized channel (e.g. `whatsapp`) |
| `instance_id` | Omni instance id |
| `provider_message_id` | `reaction:{targetMessageId}:{emoji}:{senderId}` |
| `raw_chat_id` | Raw `chatId` from the reaction payload |
| `raw_sender_id` | Raw `from` from the reaction payload |
| `normalized_sender_id` | Stripped JID sender id |
| `actor_type` | `contact` when resolvable, otherwise `unknown` |
| `contact_id` | Resolved contact id when available |
| `agent_id` | Resolved agent id when the sender is an agent |
| `platform_identity_id` | Resolved platform identity id when available |
| `message_type` | `reaction` |
| `content_json` | `{ type: "reaction", targetMessageId, emoji, senderId }` |
| `raw_provenance_json` | `{ source: "omni.reaction.received", eventId, subject, channelType, instanceId, chatId, from, accountId }` |
| `provider_timestamp` | Reaction event timestamp |
| `ingested_at` | Processing timestamp |

### Count Semantics

- Queries that count chat messages for display or CRM purposes MAY exclude `message_type = 'reaction'` rows when only conversational messages are relevant.
- Queries that need full chat activity history SHOULD include reactions.
- The existing `chat_messages` indexes on `(chat_id, provider_timestamp)` and `(contact_id, provider_timestamp)` cover reaction queries without additional indexes.

## Inbound Flow

```text
REACTION stream (JetStream)
  -> handleReactionEvent
  -> parse subject for channelType + instanceId
  -> resolve accountId from instanceId
  -> resolve/upsert chat from chatId + instance
  -> resolve sender identity (platform identity, contact)
  -> build deterministic provider_message_id
  -> dbUpsertChatMessage(message_type = "reaction", ...)
  -> emit ravi.inbound.reaction { targetMessageId, emoji, senderId }
```

The flow MUST NOT touch route resolution, session dispatch, prompt building, or runtime turn creation.

## Compatibility

- `ravi.inbound.reaction` payload remains `{ targetMessageId, emoji, senderId }`. No `chatId` or domain state is added to this event without updating specs, catalog, docs, and tests.
- `src/approval/service.ts` continues to subscribe to `ravi.inbound.reaction` and match by `targetMessageId`.
- `src/triggers/topic-catalog.ts` continues to document `ravi.inbound.reaction` as the canonical reaction trigger subject.
- `src/sdk/gateway/streaming/channels.ts` continues to subscribe to `reaction.received.>` for `chats/<chatId>` streams and filter by `chatId`. The streaming channel receives the raw omni event envelope, not the `ravi.inbound.reaction` event.

## Acceptance Criteria

- Each inbound reaction is persisted exactly once in `chat_messages` with `message_type = 'reaction'`.
- Duplicate events with the same `targetMessageId + emoji + senderId` do not create duplicate rows.
- `ravi.inbound.reaction` is still emitted with `{ targetMessageId, emoji, senderId }`.
- Approval by reaction continues to work.
- Reactions do not enter the `message.received` path, do not publish user prompts, and do not create runtime turns.
- Chat streaming classifies/projects `reaction.received.>` as reaction events for `chats/<chatId>` and filters by chat id.
