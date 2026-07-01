# Reaction Accounting / CHECKS

## Durable Persistence

- A `reaction.received` event for a known instance and chat creates a `chat_messages` row with `message_type = 'reaction'`.
- The `content_json` contains `{ type: "reaction", targetMessageId, emoji, senderId }`.
- The `raw_provenance_json` contains event id, subject, channel type, instance id, chat id, and sender data.
- The `provider_message_id` follows the deterministic pattern `reaction:{targetMessageId}:{emoji}:{senderId}`.

## Idempotency

- Two identical `reaction.received` events (same `targetMessageId + emoji + senderId`) produce exactly one `chat_messages` row.
- A different emoji from the same sender on the same message produces a separate row.
- A different sender with the same emoji on the same message produces a separate row.

## Event Emission

- `ravi.inbound.reaction` is emitted with `{ targetMessageId, emoji, senderId }` after every processed reaction, regardless of whether durable accounting succeeded.
- The event payload does not include `chatId` or domain state.

## Isolation From Message Path

- A `reaction.received` event does not enter `handleMessageEvent`.
- A `message.received` event with `content.type = "reaction"` is skipped.
- No runtime turn, user prompt, or session dispatch is created for reactions.

## Streaming Compatibility

- `chats/<chatId>` SSE stream receives `reaction.received.>` events.
- Events are classified as `"reaction"` by `classifyChatEvent`.
- Events for other chats are discarded by `extractChatId` filtering.

## Approval Compatibility

- `src/approval/service.ts` subscribes to `ravi.inbound.reaction` and resolves approvals by `targetMessageId`.
- Approval flow is unaffected by the addition of durable accounting.

## Trigger Compatibility

- `ravi.inbound.reaction` remains the canonical trigger subject in `src/triggers/topic-catalog.ts`.
- The trigger payload schema documents `{ targetMessageId, emoji, senderId }`.

## Validation Commands

```bash
bun test src/omni/consumer-context.test.ts
bun test src/router/chat-schema.test.ts
bun test src/session-trace/channel-trace.test.ts
bun test src/triggers/__tests__/topic-catalog.test.ts
bun test src/approval/service.test.ts
bun test src/sdk/gateway/streaming/channels.test.ts
bun run typecheck
```
