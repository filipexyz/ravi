---
id: channels/chats/reactions/runbook
title: "Reaction Accounting Runbook"
kind: capability
domain: channels
capability: reactions
status: draft
normative: false
---

# Reaction Accounting Runbook

## Verify Reaction Accounting Is Working

```bash
# Subscribe to live reaction events
nats sub "reaction.received.>" --server nats://127.0.0.1:4222

# After sending a reaction, check the chat_messages table
sqlite3 ~/.ravi/ravi.db "SELECT id, chat_id, message_type, content_json, provider_timestamp FROM chat_messages WHERE message_type = 'reaction' ORDER BY ingested_at DESC LIMIT 5;"
```

## Inspect Reaction History For A Chat

```bash
sqlite3 ~/.ravi/ravi.db "SELECT normalized_sender_id, json_extract(content_json, '$.emoji') AS emoji, json_extract(content_json, '$.targetMessageId') AS target, provider_timestamp FROM chat_messages WHERE chat_id = '<chat-id>' AND message_type = 'reaction' ORDER BY provider_timestamp DESC;"
```

## Verify Idempotency

Send the same reaction twice. The second event MUST NOT create a duplicate row:

```bash
sqlite3 ~/.ravi/ravi.db "SELECT COUNT(*) FROM chat_messages WHERE message_type = 'reaction' AND provider_message_id = 'reaction:<targetMessageId>:<emoji>:<senderId>';"
# Expected: 1
```

## Check Approval By Reaction Still Works

1. Trigger an approval flow that sends a message and waits for a reaction.
2. React with thumbs up.
3. Confirm the approval resolves.
4. Confirm the reaction is also persisted in `chat_messages`.

## Diagnose Missing Reaction Accounting

If a reaction event fires but no `chat_messages` row appears:

1. Check daemon logs for warnings about unknown instanceId or unresolvable chat.
2. Verify the instance is registered: `ravi instances list`.
3. Verify the chat exists: `sqlite3 ~/.ravi/ravi.db "SELECT * FROM chats WHERE platform_chat_id = '<chatId>';"`.
4. When the chat does not exist, the reaction handler skips durable accounting but still emits `ravi.inbound.reaction`. This is expected for reactions on chats Ravi has not seen.

## Exclude Reactions From Message Counts

If a query or feature should only count conversational messages:

```sql
SELECT COUNT(*) FROM chat_messages
WHERE chat_id = ? AND message_type != 'reaction';
```
