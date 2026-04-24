---
id: daemon
title: Daemon
kind: domain
domain: daemon
capabilities:
tags:
  - runtime
  - restart
applies_to:
  - src/cli/commands/daemon.ts
  - src/slash/commands/restart.ts
owners:
  - dev
status: active
normative: true
---

# Daemon

## Intent

Daemon operations should be explicit, attributable, and safe for active user sessions.

## Invariants

- Daemon restart MUST require a human-readable message.
- Daemon restart notices MUST return to the session that initiated the restart when a runtime context exists.
- Child restart processes MUST NOT overwrite caller context captured by the parent command.

## Validation

- `bun test src/cli/commands/daemon.test.ts`

## Known Failure Modes

- Restart notice falls back to an unrelated recent session.
- Child process loses `RAVI_CONTEXT_KEY` and overwrites persisted restart metadata.
