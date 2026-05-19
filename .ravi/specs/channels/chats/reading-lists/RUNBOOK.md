# Chat Reading Lists Runbook

## Diagnose A Missing Delta

1. Confirm the chat is a member of the reading list.
2. Confirm the reader identity used for the query.
3. Read the cursor for `list_id + chat_id + reader_type + reader_id`.
4. Confirm durable messages/events exist after the cursor.
5. Confirm permission checks are not filtering messages or contacts from the response.
6. Confirm the caller did not accidentally mark the cursor read in a previous call.

## Diagnose Cursor Contamination

If a chat appears read in the wrong workflow:

1. Compare cursors for the same chat across all lists.
2. Verify mark-read updated only one `list_id`.
3. Verify observer jobs use system/workflow reader ids, not human reader ids.
4. Verify dynamic membership refresh did not recreate the list id.
5. Check cursor history/audit for previous and new cursor positions.

## Backfill

1. Create default lists for existing operational queues only when there is a clear workflow owner.
2. Add chats from current pending/route/CRM review surfaces.
3. Initialize cursors as unread unless migration evidence proves a chat was already reviewed in that workflow.
4. Do not infer read cursors from session transcript length alone.
5. Preserve cursor history when moving chats between static and dynamic lists.

## Safe Defaults

- Delta query does not mark read by default.
- Mark-read requires explicit cursor target.
- Human cursor and observer cursor are separate.
- Removing a chat from a list keeps cursor history.
- Dynamic selector changes do not delete cursor history.
