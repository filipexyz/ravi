---
id: cli/calendar
title: Calendar CLI Checks
kind: checks
domain: cli
capability: calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Calendar CLI Checks

## JSON

- Every calendar command consumed by agents supports `--json`.
- JSON output uses local ids first.
- Errors are machine-readable and sanitized.
- Event list/search commands are bounded by explicit `--from`/`--to` or a
  documented safe default window.

## Permission Isolation

- `events list` without explicit calendar scopes to the requester.
- Unauthorized agents cannot read event details.
- `availability` with free/busy permission redacts private details.
- Calendar sharing requires `calendar:manage`.
- `calendars create` without explicit owner uses the active contact actor when
  one is resolved in runtime context.
- Recurring events are not expanded outside the requested output window.

## Local-First Writes

- `events create` creates local event/outbox before provider calls.
- `events update` creates local update/outbox before provider calls.
- `events cancel` creates local cancel/outbox before provider calls.
- `events respond` creates local response/outbox before provider calls.

## Suggested Validation Commands

```bash
bun test src/cli/commands/calendar.test.ts
bun test src/calendar/*.test.ts
bun run typecheck
bun run build
```
