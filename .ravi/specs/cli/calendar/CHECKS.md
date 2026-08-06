---
id: cli/calendar
title: Calendar CLI Checks
kind: checks
domain: cli
capability: calendar
status: active
normative: false
owners:
  - ravi-dev
---

# Calendar CLI Checks

## Agent-First Contract

- `calendars show <unknown>` and `calendars events read <unknown>` with `--json`
  MUST exit 1 with the `CALENDAR_NOT_FOUND` / `EVENT_NOT_FOUND` envelope; the
  calendar envelope MUST carry up to three `suggestions` from visible calendars.
- `calendars sources sync <unknown>` with `--json` MUST exit 1 with the
  `SOURCE_NOT_FOUND` envelope and suggestions from local sources.
- `calendars outbox inspect|retry <unknown>` with `--json` MUST exit 1 with the
  `OUTBOX_NOT_FOUND` envelope and a `suggestedAction` pointing at the listing.
- `calendars share` without `--execute` MUST exit 3 with `dryRun: true` and the
  `plan`, and MUST NOT insert a membership row; with `--execute` the grant MUST
  happen.
- `calendars events cancel` and `calendars events respond` without `--execute`
  MUST exit 3 and MUST NOT mutate the event or enqueue an outbox row; with
  `--execute` the local write and outbox row MUST happen.
- Validation and permission checks on braked ops MUST run before the brake, so
  a dry-run against a missing event still yields `EVENT_NOT_FOUND` (exit 1),
  never a misleading exit-3 plan.
- Listing ops (`events list`, `calendars list`, `sources list`, `outbox list`,
  `availability`) with `--fields a,b,c --json` MUST return items containing only
  the requested fields.
- A thrown `ContractError` MUST pass through `runCalendarCommand` untouched —
  never re-wrapped into a `CloudAuthError` exit-1 body.
- Unbraked writes declared in the SPEC (`events create/update`, `sources
  create/sync`, `calendars create/disable`, `outbox retry`) MUST keep
  immediate-write behavior while no provider delivery adapter exists.
- The known gaps MUST stay recorded in the SPEC while they exist: no dedicated
  `calendar` skill ships this surface, and the parser-level usage contract is
  not installed for `calendars` (usage errors are not yet exit 2).

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
bun test src/cli/commands/calendar.test.ts   # includes the "calendar agent-first contract" block
bun test src/calendar/*.test.ts
bun run typecheck
bun run build
```
