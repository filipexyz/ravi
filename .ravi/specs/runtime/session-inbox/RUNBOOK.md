---
id: runtime/session-inbox/runbook
title: "Session Inbox Runbook"
kind: runbook
domain: runtime
capability: session-inbox
status: draft
normative: false
---

# Session Inbox Runbook

## See what waits for a session

```sql
SELECT id, source_kind, source_ref, title, state, created_at, reserved_turn
FROM session_inbox WHERE target_session_name = 'main' ORDER BY created_at;
```

## Let the heartbeat drain the inbox

```bash
ravi settings set inbox.drainOnHeartbeat true
```

Default is off: only a turn with a human message drains it.

## An item looks stuck in `reserved`

A turn reserved it and never confirmed (crash between render and send). The next reservation of
that session returns it to `pending` after `INBOX_STALE_RESERVATION_MS` (10 min). Nothing else is
needed.

## The block did not appear in a human turn

Check the daemon log for `Session inbox render failed`. The turn continues without the block and
the items stay `pending` for the next draining turn.
