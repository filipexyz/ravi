---
id: sessions/handoffs
title: Session Handoffs
kind: capability
domain: sessions
capability: handoffs
tags:
  - sessions
  - threads
  - orchestration
applies_to:
  - src/handoffs/store.ts
  - src/handoffs/service.ts
  - src/handoffs/reconcile.ts
  - src/handoffs/events.ts
  - src/channels/slack/thread-lifecycle.ts
  - src/cli/commands/sessions.ts
  - src/router/router-db.ts
  - src/gateway.ts
  - src/daemon.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Session Handoffs

## Intent

A handoff is the stored fact "this child session (a thread) waits for its parent session to act". Before it, the wait lived only in the text of a report: a thread that ended its turn and waited was healthy for every turn-health check, so an orchestrating parent that stopped acting was noticed only when a human asked why everything was stopped.

## Rules

- A child declares a handoff with `ravi sessions report --awaiting <review|decision|merge|dispatch|instruction> [--ref <sha|pr>] "<message>"`. The report text carries the handoff id.
- The thread brief the runtime builds (`src/prompt-builder.ts`, Slack thread placement) and the thread-return nudge MUST tell the thread to end a waiting report with `--awaiting`; a wait the thread never declares is invisible to the reconciler.
- A child waits on one thing at a time: a new handoff from the same child MUST supersede its open one.
- The handoff MUST be written only after its report reached the parent: a report that fails to publish leaves the previous wait open and untouched. A blank waiting report is a usage error.
- A handoff MUST close only on an explicit reference to that child or that handoff: the parent sends the thread instructions (`thread-send`), closes it (any close path: `close-thread`, the Slack close command, idle close; the acknowledgement lives in the shared close), or runs `ravi sessions handoff-ack <id>`. Unrelated activity of the parent MUST NOT close it.
- The reconciler (gateway tick, every 30 s) MUST remind the parent once when a handoff has waited 15 min, with one turn per parent per tick listing every open handoff of that parent, and MUST tell the owner once, in one aggregated message per parent, for handoffs that waited 45 min.
- A delivery that was not made MUST NOT be recorded as made: a failed or refused reminder or notice leaves the row as it was, to retry on the next tick.
- The core (`src/handoffs/`) MUST NOT name a channel. Channel adapters register the parent reminder (`registerHandoffDeliveryPorts`); the owner notice uses the owner's direct chat resolved from contacts.
- Events `ravi.handoff.pending`, `ravi.handoff.acknowledged` and `ravi.handoff.stale` carry `{type, handoffId, threadSession, parentSession, kind, sha?, since, ageMin, reason?}`. Observers consume them as a ready condition; they never infer a wait from report text. Publishing is best effort; the table is the source of truth.
