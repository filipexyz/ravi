---
id: runtime/session-inbox/why
title: "Session Inbox Why"
kind: why
domain: runtime
capability: session-inbox
status: draft
normative: false
---

# Why a session inbox

Every notice from a thread, cron, observer or child run reaches its session through
`publishSessionPrompt`. The delivery barriers (`immediate_interrupt` to `after_task`) choose where
inside a turn a message lands, but none waits for a person: an idle session always wakes. The
`main` session answers most of those woken turns with `@@SILENT@@`, and each one is a turn of a
long persistent session (the 23/11 measurement put it near 556 thousand cached tokens per delivery).

Luís asked (25/11) that such notices fall to the agent but be read only from the next turn in
which he writes, together, so the summary of what he missed is clearer.

Signals `piggyback` already rides the next turn with a reserve, commit and release ledger, and the
inbox reuses that seam (`transformTurnPrompt`). It is not reused as is because a signal models a
condition of the world (keys, `clearWhen`, open and resolved), surfaces on any turn, and its budget
drops what does not fit; a notice is a message, must reach a person's turn, and must not be lost.

JetStream is not the store because the session prompt stream is a work queue: holding a message
unacknowledged for hours keeps consumers and redelivery busy.
