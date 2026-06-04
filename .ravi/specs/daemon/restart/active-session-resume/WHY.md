# Restart Active Session Resume / WHY

## Rationale

Daemon restarts are normal during development and deploys, but they currently behave like a hard interruption unless the user manually nudges each affected session.

The existing restart context preservation spec solves the session that requested the restart. It does not cover other sessions that were also working. A restart can interrupt build/test work, channel responses, tool execution, approval waits, or queued prompts in those sessions.

The correct product behavior is to treat daemon restart as a continuity event for recently active work. The agent already has durable session history and traces; it should receive an explicit system event that tells it why it is waking back up.

## Why 1 Hour

Without a time cap, Ravi can wake stale work from hours or days ago after a restart. That is noisy and can produce outdated actions.

A 1 hour window is long enough for normal restarts, rebuilds, machine sleeps, and local debugging. It is short enough to avoid reviving old sessions whose context is no longer operationally fresh.

## Tradeoffs

- Fan-out resume creates more post-restart work, but only for sessions that were non-idle or had undelivered work.
- The event is a session input rather than a direct channel message, so normal routing, output attachment, permissions, and silence rules remain centralized.
- Best-effort shutdown snapshots are useful but cannot be the only source of truth; crash/restart recovery needs durable trace/live-state reconstruction too.
- The 1h cap can miss an interrupted long-running task after a long outage, but auto-continuing after that long is more dangerous than requiring a user nudge.

