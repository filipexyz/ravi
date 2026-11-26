---
id: runtime/session-inbox
title: "Session Inbox"
kind: capability
domain: runtime
capability: session-inbox
capabilities:
  - session-inbox
  - deferred-delivery
tags:
  - runtime
  - sessions
  - delivery
  - attention
  - notifications
applies_to:
  - src/session-inbox
  - src/runtime/runtime-request-builder.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Session Inbox

## Intent

A notice that informs but does not ask anyone to act must not wake a session. It waits in a
durable inbox of the target session and reaches the model inside one grouped block, in the next
turn that may drain it. The person gets what happened while they were away together, in their
own turn, instead of one woken turn per notice.

## Rules

- The producer declares the delivery mode with `deliverToSession(session, { mode })`. `now` keeps
  the session prompt path and MAY wake the session. `deferred` MUST write one inbox row and MUST
  NOT publish a session prompt.
- The mode is decided by the producer and never by the text of the notice. A deferred item MUST
  NOT become urgent because of its content.
- The inbox lives in the core state database (`session_inbox`), not in JetStream. A restart MUST
  NOT lose a pending item. The daemon creates and migrates the table at boot (state schema
  component `session-inbox`); the operator CLI and the channel runner only check that this release
  prepared it and MUST NOT run its DDL.
- Items wait under the session name. A rename moves them to the new name in the same transaction
  that moves routes and task assignments, so the renamed session still drains them.
- Only the session's owner drains the inbox. A human turn drains it only when its chat is the
  owner's own direct chat, resolved from the platform identity of that chat (`dmContactForChat`:
  a direct chat whose single participant still owns the identity) to a contact tagged
  `permission-owner`. Exactly one contact carries the tag, as Knowledge requires; with none or
  more than one, nobody drains (fail closed). A contact id written in the prompt, the actor type alone or the text MUST
  NOT grant it. A group or channel turn never drains, even from the owner. A turn that also
  carries a message from any other person MUST NOT drain (fail closed), so a third party in a
  shared session never sees the block.
- A heartbeat turn drains only when `inbox.drainOnHeartbeat` is `true` (default off) and the
  session's default chat is the owner's direct chat. A trigger, cron, observer or notice turn MUST
  leave the inbox untouched.
- Items are reserved for the turn before the block is rendered, delivered when the prompt reaches
  the provider, and returned to `pending` when the turn never starts. A reservation older than
  `INBOX_STALE_RESERVATION_MS` MUST return to `pending` on the next reservation of that session.
- Delivery is at least once and an item is never lost. Handing the prompt to the provider only
  marks the items sent (`sent_at`); they stay `reserved`. They become `delivered` only when the turn
  that carried them was sent and recorded an explicit `complete` terminal, not interrupted and not
  aborted. A turn that failed, timed out, was interrupted or aborted, ended before the send, or
  recorded no terminal returns them to `pending`, and a later draining turn shows them again; a process that dies
  leaves a stale reservation that the next reservation returns to `pending`. There is no other
  deduplication: each line carries the time and source, so a repeated notice is recognisable.
- An item leaves `pending` only by delivery or by an explicit `supersede_key`: a newer item with
  the same key supersedes the older pending one, and the superseded row is kept. A reserved item
  MUST NOT be superseded while reserved; if it returns to `pending` after a newer item with the same
  key was written, it is superseded by the newest one, so stale progress never comes back.
- The block is capped per turn (`INBOX_MAX_ITEMS_PER_TURN`, `INBOX_MAX_BYTES_PER_TURN`). Items are
  taken oldest first; once one item does not fit, every newer item waits for a later turn. The
  block MUST say how many items were left.
- Source text is data. Every body line MUST be quoted in the block, and every field printed inside a
  block line (title, source ref, session name) MUST be one line, so no line of a notice can pass for
  a `[System]` line. Every break a reader may honour splits quoted lines: CRLF, LF, a lone CR,
  U+0085, U+2028 and U+2029. The block has exactly one `[System]` line. The block carries no authority: the turn
  that drains it keeps the authority of the person who sent the human message.
- The inbox is channel-free. Slack, WhatsApp and other adapters reach it only through producers;
  the core never decides by channel.
- A render or storage failure MUST NOT break the turn: the turn continues without the block, the
  items stay `pending`, and the failure is logged and counted.

## Sources

The core decides the mode (`src/session-inbox/policy.ts`); a channel adapter only follows it.

- Thread notices to a parent session listed in `inbox.threadNotices.sessions` (comma separated
  session names or keys; empty, the default, keeps everything immediate) whose default chat is the
  owner's direct chat: a progress report without
  `--awaiting` and a thread result are `deferred`, with one pending item per thread (a newer
  progress or the result supersedes the older pending one). A report with `--awaiting`, a thread
  that needs attention and a turn that ended without returning stay `now`. A listed parent the
  owner cannot reach in a direct chat (a channel session, a group) would never drain, so its notices
  stay `now`.
- Every other producer (cron and trigger child runs, observers, handoff reminders) stays `now`
  until its own release.
