# Reaction Accounting / WHY

## Problem

Inbound reactions arrive via the `REACTION` JetStream stream and are processed by `OmniConsumer.handleReactionEvent`. The handler deduplicates by `messageId:emoji:senderId`, emits `ravi.inbound.reaction`, and discards the event. No durable record is created.

This means:

- Reaction history is not queryable after the daemon restarts.
- There is no chat-level ledger entry for reactions, unlike regular messages which are persisted in `chat_messages`.
- Operators and agents cannot audit which reactions were received, when, or from whom.
- CRM contact timeline and chat activity views are incomplete because reactions are invisible.
- The only consumer of reaction events is real-time: approval service and trigger runner. If they miss an event, it is gone.

## Decision

Persist each inbound reaction as a `chat_messages` row with `message_type = 'reaction'` and a deterministic `provider_message_id` derived from `reaction:{targetMessageId}:{emoji}:{senderId}`.

## Why `chat_messages` And Not A Separate Table

- The existing `chat_messages` table already has the right schema: actor metadata, provenance, timestamps, idempotency constraint, and chat-scoped indexes.
- Reactions are chat-level events with a sender, a target, and a timestamp. They fit the existing data model.
- Adding a `reactions` table would duplicate the same columns, indexes, and query patterns. The only difference would be `message_type`, which is already a column on `chat_messages`.
- Count and timeline queries can filter by `message_type` when they need to exclude reactions.

## Why Not `session_events`

- `session_events` is a runtime trace surface scoped to agent sessions, not the canonical chat ledger.
- Reactions are chat-level facts that exist independently of which agent session is running.
- Storing reactions only in `session_events` would make them invisible to chat queries, CRM, and contact timeline.

## Tradeoff

- `chat_messages` will contain rows that are not conversational messages. Queries that assume all `chat_messages` are text/media messages must add `WHERE message_type != 'reaction'` or equivalent.
- The deterministic `provider_message_id` means the same reaction from the same sender on the same message is idempotent, but a different emoji from the same sender on the same message creates a separate row. This matches the semantic intent: each distinct reaction is a separate accounting entry.
