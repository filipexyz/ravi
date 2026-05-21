---
id: daemon/restart/active-session-resume
title: Restart Active Session Resume
kind: feature
domain: daemon
capability: restart
capabilities:
  - restart
  - runtime-context
  - session-continuity
tags:
  - daemon
  - restart
  - sessions
  - continuity
applies_to:
  - src/cli/commands/daemon.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/session-launcher.ts
  - src/runtime/host-event-loop.ts
  - src/runtime/live-state.ts
  - src/db.ts
  - src/session-trace
owners:
  - dev
status: draft
normative: true
---

# Restart Active Session Resume

## Intent

When Ravi restarts, every session that was doing user-visible work shortly before the stop should receive a durable system event saying Ravi restarted so the agent can continue from where it left off.

The event is a continuity trigger, not a chat notification blast. It should resume interrupted work without waking old or idle sessions.

## Terms

- **Restart epoch**: one daemon lifecycle boundary, identified by a stable restart id, boot id, or persisted restart marker.
- **Restart resume event**: a system prompt delivered to an affected session after daemon boot, for example `[System] Daemon reiniciou (<reason>). Continue de onde parou.`
- **Runtime-active session**: a session whose runtime state was not idle when the daemon stopped, or whose dispatcher had undelivered work.
- **Recent stopped session**: a runtime-active session whose last runtime activity or stop snapshot is less than the restart resume window old.
- **Restart resume window**: 1 hour. Sessions older than this MUST NOT be automatically resumed.

## Eligibility

A session MUST be eligible for restart resume only when all of the following are true:

- It had runtime activity inside the restart resume window: `last_activity_at >= restart_started_at - 1h`, or an equivalent monotonic snapshot captured before shutdown.
- It was not idle at the stop boundary, or it had undelivered work. Non-idle includes thinking, streaming, compacting, awaiting approval, blocked on tool/user input, pending start, queued prompt, active turn, pending abort, or pending delivery barrier.
- It is not deleted, expired, or explicitly disabled for runtime delivery.
- It has not already received the restart resume event for the same restart epoch.

A session MUST NOT be eligible when all of the following are true:

- Its latest known live activity was `idle`.
- It had no pending messages, pending starts, active turn, pending abort, active tool, approval request, or delivery barrier.
- Its latest activity was older than 1 hour before restart.

## Event Contract

- Daemon boot MUST emit a restart resume event to every eligible session.
- The event MUST be delivered as a session input, not as a direct channel output.
- The event MUST be persisted in session history/trace like other system commands.
- The event MUST include restart reason/message when available.
- The event MUST include restart epoch metadata so delivery is idempotent.
- The event MUST tell the agent to continue prior work, not ask the user to restate the task.
- The event MUST NOT override the session output target. Normal session output resolution still applies.
- The event MUST NOT be emitted to sessions whose last eligible activity is older than 1 hour.

## Idempotency

- Ravi MUST record restart resume delivery per `(restart_epoch, session_key)`.
- Re-running boot hooks for the same restart epoch MUST NOT duplicate resume events.
- If delivery fails transiently before the event is persisted, Ravi MAY retry within the same restart resume window.
- If the daemon restarts again, the new restart epoch MAY emit a new event only for sessions still eligible under the new 1h window.

## Stop Snapshot Requirements

Before or during shutdown, Ravi SHOULD persist a best-effort runtime activity snapshot for live sessions. The snapshot SHOULD include:

- session key and canonical session name.
- agent id and provider id.
- runtime activity (`idle`, `thinking`, `streaming`, `compacting`, `awaiting_approval`, `blocked`, or equivalent).
- `turnActive`, pending message count, pending start state, pending abort state, active tool state, approval wait state, and delivery barrier state.
- `last_activity_at` and `stopped_at`.
- restart reason/message when known.

If graceful shutdown does not capture a snapshot, daemon boot MAY reconstruct eligibility from durable session trace/live-state rows, but MUST still enforce the 1h window and idempotency.

## Runtime Behavior

- The restart resume event SHOULD enter the same dispatcher path as other system inputs.
- If the session has pending user messages, the resume event MUST NOT clear or reorder them.
- If the previous provider turn was interrupted by daemon stop, the next turn SHOULD preserve pending prompt atoms and durable history according to `runtime/session-continuity`.
- If the session was awaiting user approval, Ravi SHOULD resume with enough context for the agent to re-ask or continue safely; it MUST NOT auto-approve.
- If workspace or tool side effects are ambiguous, the agent SHOULD explain the resumed state briefly before continuing.

## Acceptance Criteria

- Restart while a session is actively working emits one restart resume event to that session after boot.
- Restart while several sessions are actively working emits one restart resume event to each eligible session.
- Restart while a session is idle emits no resume event to that session.
- Restart after a session stopped more than 1 hour ago emits no resume event to that session.
- Reboot hook replay for the same restart epoch does not duplicate events.
- The caller-session restart notice from `daemon/restart/context-preservation` continues to work; this feature adds fan-out resume for other active sessions.

