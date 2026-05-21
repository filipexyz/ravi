---
id: daemon/restart/context-preservation
title: Restart Context Preservation
kind: feature
domain: daemon
capabilities:
  - restart
  - runtime-context
tags:
  - cli
  - slash
  - restart
applies_to:
  - src/cli/commands/daemon.ts
  - src/slash/commands/restart.ts
owners:
  - dev
status: active
normative: true
---

# Restart Context Preservation

## Intent

When a session asks for a daemon restart, the post-restart notice should return to that same session automatically.

This feature covers caller notification. Fan-out resume for every recently non-idle session is specified separately in `daemon/restart/active-session-resume`.

## Invariants

- Parent restart commands MUST persist the caller session context when available.
- Child restart commands MUST preserve existing caller context if they do not have their own context.
- Restart notices MUST NOT fall back to an unrelated session while a caller context exists.
- Slash restart MUST pass enough context for the CLI handoff to identify the caller.
- Caller notification MUST coexist with active-session resume fan-out without duplicating the same restart event for the caller session.

## Validation

- `bun test src/cli/commands/daemon.test.ts`

## Known Failure Modes

- Parent writes `{ reason, sessionName }`, then child process overwrites it with `{ reason }`.
- Restart notice lands in an unrelated session after daemon comes back.
