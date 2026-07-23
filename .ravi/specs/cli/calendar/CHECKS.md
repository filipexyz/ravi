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

- Every calendar command consumed by agents MUST support `--json`.
- JSON output MUST use local ids first.
- Errors MUST be machine-readable and sanitized.
- Event list/search commands MUST be bounded by explicit `--from`/`--to` or a
  documented safe default window.

## Permission Isolation

- `events list` without explicit calendar MUST scope to the requester.
- Unauthorized agents MUST NOT read event details.
- `availability` with free/busy permission MUST redact private details.
- Calendar sharing MUST require `calendar:manage`.
- `calendars create` without explicit owner SHOULD use the active contact actor when
  one is resolved in runtime context.
- Recurring events MUST NOT be expanded outside the requested output window.

## Local-First Writes

- `events create` MUST create local event/outbox before provider calls.
- `events update` MUST create local update/outbox before provider calls.
- `events cancel` MUST create local cancel/outbox before provider calls.
- `events respond` MUST create local response/outbox before provider calls.

## Suggested Validation Commands

```bash
bun test src/cli/commands/calendar.test.ts
bun test src/calendar/*.test.ts
bun run typecheck
bun run build
```
