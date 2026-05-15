# Why Chat Reading Lists

## Decision

Add chat reading lists as a first-class chat feature.

Each reading list groups chats for a workflow and stores independent read cursors per chat and reader.

## Rationale

Ravi needs more than "pending" or "latest messages".

Operators and agents need to ask:

- what changed in this chat since I last reviewed it for this workflow?
- which chats in this queue have unread changes?
- can an observer process only the new messages since its last run?
- can the same chat be reviewed in CRM and support without one review hiding work from the other?

That requires a cursor scoped to the list, chat, and reader.

## Why Not Global Read State

Global unread/read state collapses workflows.

If a user reads a chat in `support-followups`, that should not mark it read in `crm-analysis-pending`.

If an observer processes a chat, that should not mark it read for a human.

Scoped cursors preserve workflow independence.

## Why This Is Chat Layer

The object being read is a chat message stream.

Contacts, CRM profiles, observers, and routes can all use reading lists, but none of them should own the chat cursor model.

## Why Durable Message Anchors Matter

The system can only answer "what changed since last read" if the cursor points into a durable ordered message/event ledger.

`message_metadata` is a TTL cache for reply/media reinjection. Runtime session transcripts are scoped to agents and may not exist for pending chats. Neither is enough for reliable reading-list cursors.

## Tradeoff

Supporting both list scope and reader scope adds one more dimension to the cursor key, but it avoids the common failure where automated processing consumes human unread state or one workflow hides another workflow's unread work.
