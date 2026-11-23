# Session Handoffs Runbook

- See what is waiting: `ravi sessions handoffs [--session <parent>] [--json]`. Each line names the thread, the kind, the ref, the age and the handoff id.
- Close a handoff for an action that does not message the thread (for example, a review dispatched to a new thread): `ravi sessions handoff-ack <id> --reason "review dispatched"`. `thread-send` to the thread and `close-thread` close it on their own.
- A parent reminder or owner notice that did not go out stays owed: the gateway retries every 30 s. Check the gateway log for `Handoff parent reminder failed` or `Handoff owner notice failed`. The owner notice needs exactly one contact tagged `permission-owner` with a reachable direct chat.
- Inspect rows: `SELECT id, kind, status, created_at, parent_nudged_at, owner_escalated_at, ack_reason FROM session_handoffs ORDER BY created_at DESC LIMIT 20;` (read only).
