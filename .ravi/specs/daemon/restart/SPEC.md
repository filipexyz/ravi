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

## Invariants

- `ravi daemon restart` MUST always restart when called.
- `-m` / `--message` MUST remain required.
- Restart context SHOULD be captured transparently from the current runtime context.
- Users SHOULD NOT need to pass a manual notify-session flag for normal restarts.

## Validation

- `bun test src/cli/commands/daemon.test.ts`

## Known Failure Modes

- Restart gets scheduled instead of restarting when called.
- Notice is delivered to the wrong session.
