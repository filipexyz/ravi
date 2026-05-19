---
id: channels/chats/reading-lists
title: Chat Reading Lists
kind: feature
domain: channels
capability: chats
feature: reading-lists
tags:
  - channels
  - chats
  - reading-lists
  - cursors
  - observers
  - crm
applies_to:
  - src/router/router-db.ts
  - src/omni/consumer.ts
  - src/db.ts
  - src/cli/commands
  - src/contacts.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Chat Reading Lists

## Intent

Chat reading lists let Ravi group chats into named review surfaces and remember the last message read for each chat inside each list.

The same chat MAY belong to multiple reading lists. Each list MUST maintain its own cursor so reading a chat in one workflow does not mark it read in another workflow.

Reading lists are for incremental review, triage, observer work, and CRM follow-up. They are not routes, sessions, contact identity, or transport state.

## Core Concepts

- `reading_list`: named collection or query over chats.
- `reading_list_member`: a chat included in a list, either manually or by a selector.
- `reading_cursor`: last-read position for one chat inside one list.
- `reader`: user, agent, team, system job, or workflow that owns a cursor.
- `delta`: messages/events after the cursor that changed since the last read.

## Product Rule

A reading list answers:

```text
For this workflow/list, what changed in this chat since I last read it here?
```

It MUST NOT answer:

```text
Has everyone globally read this chat?
```

Global unread state MAY exist separately later, but reading lists MUST be scoped to the workflow/list and reader.

## Data Model

### `chat_reading_lists`

Suggested fields:

- `id`
- `name`
- `description`
- `owner_type`: `user`, `agent`, `team`, `system`, or `workflow`
- `owner_id`
- `visibility`: `private`, `team`, `system`, or future value
- `mode`: `static`, `dynamic`, or `hybrid`
- `selector_json`: optional query/filter definition for dynamic membership
- `metadata_json`
- `created_at`
- `updated_at`
- `archived_at`

`name` SHOULD be unique per owner scope.

When resolving a list by name, the caller SHOULD provide an owner scope or use the current agent owner scope.

If more than one active list with the same name is visible and no owner scope disambiguates it, Ravi MUST reject the operation instead of choosing the most recently updated list.

### `chat_reading_list_members`

Suggested fields:

- `list_id`
- `chat_id`
- `source`: `manual`, `selector`, `observer`, `crm`, `migration`, or future source
- `reason`
- `priority`
- `metadata_json`
- `added_at`
- `removed_at`

Constraints:

- `list_id + chat_id` SHOULD be unique for active membership.
- A chat MAY appear in many lists.
- Removing a chat from a list SHOULD NOT delete its cursor history unless explicitly requested.

### `chat_reading_cursors`

Suggested fields:

- `list_id`
- `chat_id`
- `reader_type`: `user`, `agent`, `team`, `system`, or `workflow`
- `reader_id`
- `last_read_message_id`
- `last_read_message_sort_key`
- `last_read_event_id`
- `last_read_event_sort_key`
- `last_read_at`
- `read_reason`: `manual`, `observer_run`, `crm_review`, `api`, `migration`, or future source
- `metadata_json`
- `created_at`
- `updated_at`

Constraints:

- `list_id + chat_id + reader_type + reader_id` MUST be unique.
- Updating a cursor for one list MUST NOT update another list's cursor for the same chat.
- Updating a cursor for one reader MUST NOT update another reader's cursor unless the list explicitly uses a shared/system reader.

## Cursor Semantics

The cursor MUST point to a durable ordered message/event position, not a transient array offset.

Acceptable cursor anchors:

- durable message id plus monotonic message sort key
- durable event id plus monotonic event sort key
- provider message id only when Ravi can map it to a durable local message/event record

Unacceptable cursor anchors:

- in-memory offset
- page number
- raw WhatsApp/Omni timestamp alone
- `message_metadata` row alone
- runtime session transcript position alone

Reading lists require the durable message ledger described by `contacts/identity-graph/inbound-contact-intake`.

## Delta Query

A list read SHOULD support querying a chat delta:

```text
get delta(list_id, chat_id, reader)
  -> cursor
  -> messages/events after cursor
  -> summary counts
  -> suggested next cursor
```

The delta response SHOULD include:

- `list`
- `chat`
- `reader`
- `previousCursor`
- `nextCursor`
- `messages`
- `events`
- `newMessageCount`
- `editedMessageCount`
- `deletedMessageCount`
- `participantChanges`
- `firstUnreadMessage`
- `lastUnreadMessage`

The caller MAY mark the delta as read by committing `nextCursor`.

Fetching a delta MUST NOT automatically advance the cursor unless the API/CLI explicitly requests mark-read semantics.

Delta reads MUST only return messages for chats that are active members of the requested list. A non-member chat MUST fail the delta operation rather than leaking chat history through a list name.

## Mark-Read Semantics

Mark-read MUST be explicit.

Allowed forms:

- mark this list/chat read up to a specific message id
- mark this list/chat read up to the last returned delta item
- mark this list/chat read through now when no durable message exists after the cursor

Mark-read SHOULD write an audit event or cursor history entry with reader, reason, previous cursor, and new cursor.

Mark-read MUST only update cursors for chats that are active members of the requested list.

Automatic observers MAY advance their own system/workflow cursor after successful processing, but MUST NOT advance a human user's cursor.

## Static And Dynamic Lists

MVP SHOULD support static lists:

- create list
- add chat
- remove chat
- list members
- read delta
- mark read

Dynamic lists MAY use selectors such as:

- channel and instance
- chat type
- route state
- contact policy status
- tags
- CRM lifecycle
- owner/agent
- last inbound time
- unread delta exists

Dynamic membership MUST be materialized or evaluated consistently enough that cursors remain meaningful. A chat leaving a dynamic list SHOULD keep cursor history for audit and for future re-entry.

## CRM And Observer Use

Reading lists are a natural input queue for CRM/observer work.

Examples:

- `sde-new-leads`
- `human-dms-unreviewed`
- `crm-analysis-pending`
- `support-followups`
- `high-priority-customers`

Observers SHOULD keep their own cursor per list/chat/observer. This allows one observer to process only messages that changed since its last successful run while another observer or human reviewer maintains a separate cursor.

CRM enrichment MUST NOT depend on the human review cursor. CRM jobs should use their own reader identity.

## CLI/API Contract

Suggested CLI shape:

```bash
ravi chats lists create <name> [--owner <type:id>] [--json]
ravi chats lists add <list> <chat> [--owner <type:id>] [--reason <text>] [--json]
ravi chats lists remove <list> <chat> [--owner <type:id>] [--json]
ravi chats lists members <list> [--owner <type:id>] [--json]
ravi chats lists delta <list> <chat> [--owner <type:id>] [--reader <type:id>] [--json]
ravi chats lists mark-read <list> <chat> --message <message-id> [--owner <type:id>] [--reader <type:id>] [--json]
```

If `ravi chats` does not exist yet, the feature MAY start under an existing operational command, but public naming SHOULD converge on chats because the unit being read is a chat.

API responses MUST expose structured cursors and messages, not formatting-only strings.

CLI/API responses MUST omit raw provider payloads and raw provenance by default. Diagnostics MAY expose raw provider ids or provenance only behind an explicit flag such as `--include-raw`.

## Permissions And Privacy

Reading a list MUST NOT bypass chat, contact, project, or CRM permissions.

List membership may reveal that a chat/contact belongs to a sensitive workflow. List reads SHOULD check:

- permission to read the list
- permission to read the chat
- permission to read resolved contacts or CRM data included in response

Cursor writes SHOULD require permission to update that reader's cursor or a system workflow cursor.

## Acceptance Criteria

- The same chat can belong to multiple reading lists.
- Each list stores an independent cursor for that chat.
- Each reader can have an independent cursor for the same list/chat.
- Reading a chat in one list does not advance the cursor in another list.
- Reading a chat as one reader does not advance another reader's cursor.
- Delta queries return what changed since the cursor.
- Mark-read is explicit and auditable.
- Observers can process incremental chat changes without consuming human review cursors.
- The cursor uses durable message/event anchors, not `message_metadata` or session transcript offsets.
- Dynamic list membership does not destroy cursor history.
