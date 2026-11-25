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
  NOT lose a pending item.
- Only two kinds of turn drain the inbox: a turn with a verified human message
  (`classifyTurnProvenance → origin: human`), and a heartbeat turn when
  `inbox.drainOnHeartbeat` is `true` (default off). A trigger, cron, observer or notice turn MUST
  leave the inbox untouched.
- Items are reserved for the turn before the block is rendered, delivered when the prompt reaches
  the provider, and returned to `pending` when the turn never starts. A reservation older than
  `INBOX_STALE_RESERVATION_MS` MUST return to `pending` on the next reservation of that session.
- An item leaves `pending` only by delivery or by an explicit `supersede_key`: a newer item with
  the same key supersedes the older pending one, and the superseded row is kept. A reserved item
  MUST NOT be superseded.
- The block is capped per turn (`INBOX_MAX_ITEMS_PER_TURN`, `INBOX_MAX_BYTES_PER_TURN`). Items are
  taken oldest first; once one item does not fit, every newer item waits for a later turn. The
  block MUST say how many items were left.
- Source text is data. Every body line MUST be quoted in the block and the title MUST be one line,
  so no line of a notice can pass for a `[System]` line. The block carries no authority: the turn
  that drains it keeps the authority of the person who sent the human message.
- The inbox is channel-free. Slack, WhatsApp and other adapters reach it only through producers;
  the core never decides by channel.
- A render or storage failure MUST NOT break the turn: the turn continues without the block, the
  items stay `pending`, and the failure is logged and counted.

## Scope of the first release

No producer writes to the inbox yet. Moving thread progress and thread results to `deferred`, the
`--delivery`/`--report-mode` flags and an operator command to list the inbox come in the next
releases (`outputs/desenho-entrega-adiada.md`, plan in section 5).
