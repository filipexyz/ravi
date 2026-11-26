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
- A trigger, cron or notice turn leaves every item `pending`; the owner's direct-chat turn gets them in one block.
- A third party's turn, a batch with the owner and a third party, and the owner in a group never drain.
- A contact id written in the prompt does not make a turn the owner's.
- A heartbeat drains only with `inbox.drainOnHeartbeat=true` and the owner's direct chat as default chat.
- A released reservation returns to `pending`; a stale one returns on the next reservation.
- A reserved item is never superseded; a superseded row is kept.
- The byte cap never lets a newer item jump ahead of an older one.
- Every body line is quoted; a multi-line title, source ref or session name stays on one line; the block has exactly one `[System]` line.
- The composition with Signals commits and releases both settlements.
- Pending items survive closing and reopening the database.
- Handing the prompt to the provider leaves the items `reserved` with `sent_at`; a completed turn
  delivers them; an interrupted or aborted turn returns them to `pending`.
- A lone CR, U+0085, U+2028 and U+2029 split quoted lines; U+0085 stays out of titles and refs.
- Two contacts tagged as owner: nobody drains.
- The owner's real direct chat drains; a stranger's direct chat and a group do not (no injected lookups).
- With the parent listed, thread progress and the result wait in its inbox (one per thread);
  `--awaiting` stays immediate; an unlisted parent gets every notice immediately.

```bash
env -u RAVI_STATE_DIR -u RAVI_CONTEXT_KEY NATS_URL=nats://127.0.0.1:1 bun test src/channels/slack/thread-lifecycle.test.ts -t "inbox|listed"
```
