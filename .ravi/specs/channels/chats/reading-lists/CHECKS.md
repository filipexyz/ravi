# Chat Reading Lists Checks

## Static Checks

- No cursor table should be keyed only by `chat_id`.
- No observer should advance a human reader cursor.
- No delta query should advance a cursor unless the call explicitly requests mark-read behavior.
- No cursor should depend only on `message_metadata`, raw timestamp, page number, or runtime transcript offset.
- No reading-list API should bypass chat/contact/CRM permissions.

Suggested scan:

```bash
rg -n "reading_list|read_cursor|mark.?read|message_metadata|transcript|last_read|unread" src
```

## Runtime Tests

### Same Chat In Two Lists

Given:

- chat A is in list X and list Y
- reader R marks chat A read in list X

Expected:

- list X cursor advances
- list Y cursor does not advance

### Two Readers Same List

Given:

- chat A is in list X
- reader R1 and reader R2 both have cursors

Expected:

- R1 mark-read does not advance R2 cursor

### Observer Cursor

Given:

- observer O processes chat A in list X

Expected:

- observer cursor advances only for `reader_type='agent'` or `workflow`
- human user cursor remains unchanged

### Delta Does Not Mark Read

Given:

- unread messages exist after cursor
- caller requests delta

Expected:

- response includes messages and suggested next cursor
- stored cursor remains unchanged until mark-read

### Durable Anchor Required

Given:

- a chat has only TTL `message_metadata` and no durable message/event anchor

Expected:

- reading-list cursor creation fails or returns degraded/unavailable status
- system does not claim reliable unread delta

## Acceptance Gate

Implementation is not complete until:

- list membership supports the same chat in multiple lists
- cursor key includes list, chat, and reader
- delta and mark-read are separate operations
- observer processing does not consume human review state
- cursors survive dynamic membership removal/re-entry
- cursor anchors refer to durable ordered messages/events
