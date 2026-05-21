---
id: daemon/restart
title: Daemon Restart
kind: capability
domain: daemon
capabilities:
  - restart
tags:
  - cli
  - context
applies_to:
  - src/cli/commands/daemon.ts
  - src/slash/commands/restart.ts
owners:
  - dev
status: active
normative: true
---

# Daemon Restart

## Intent

Restart should be operationally simple while preserving the caller context needed for post-restart notification.

Restart should also preserve work continuity for other sessions that were active when the daemon stopped.

## Invariants

- `ravi daemon restart` MUST always restart when called.
- `-m` / `--message` MUST remain required.
- Restart context SHOULD be captured transparently from the current runtime context.
- Users SHOULD NOT need to pass a manual notify-session flag for normal restarts.
- Daemon boot MUST emit a restart resume event to every non-idle session that had runtime activity or pending work less than 1 hour before restart.
- Daemon boot MUST NOT emit restart resume events to idle sessions or to sessions whose eligible activity is older than 1 hour.
- Restart resume events MUST be delivered as session inputs, not direct channel sends.

## Validation

- `bun test src/cli/commands/daemon.test.ts`

## Known Failure Modes

- Restart gets scheduled instead of restarting when called.
- Notice is delivered to the wrong session.
- Restart wakes stale sessions that were inactive for more than 1 hour.
- Restart fails to resume a non-idle session that was working immediately before daemon stop.
