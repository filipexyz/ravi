---
id: runtime/session-inbox/checks
title: "Session Inbox Checks"
kind: checks
domain: runtime
capability: session-inbox
status: draft
normative: true
---

# Session Inbox Checks

```bash
env -u RAVI_STATE_DIR -u RAVI_CONTEXT_KEY NATS_URL=nats://127.0.0.1:1 bun test src/session-inbox/session-inbox.test.ts
```

- A `deferred` delivery writes one row and publishes no session prompt.
- A trigger, cron or notice turn leaves every item `pending`; a human turn gets them in one block.
- A heartbeat drains only with `inbox.drainOnHeartbeat=true`.
- A released reservation returns to `pending`; a stale one returns on the next reservation.
- A reserved item is never superseded; a superseded row is kept.
- The byte cap never lets a newer item jump ahead of an older one.
- Every body line is quoted; the block has exactly one `[System]` line.
- The composition with Signals commits and releases both settlements.
- Pending items survive closing and reopening the database.
