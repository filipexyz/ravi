---
id: cli/calendar
title: Calendar CLI
kind: capability
domain: cli
capability: calendar
tags:
  - cli
  - calendar
  - local-first
  - agents
applies_to:
  - src/cli/commands/calendar.ts
  - src/calendar
owners:
  - ravi-dev
status: draft
normative: true
---

# Calendar CLI

## Intent

`ravi calendars` is the offline-first command surface for Ravi's local calendar
and agenda layer.

Agents MUST be able to use the CLI to inspect and mutate local calendar state
without knowing which remote provider, if any, backs the calendar.

## General Rules

- Every agent-consumed command MUST support `--json`.
- Commands MUST read and write local SQLite state first.
- The public command surface MUST NOT require Console or provider configuration
  for local calendar use.
- Commands MUST enforce calendar authorization through the Permission Provider Runtime when running in agent/runtime context.
- Commands MUST NOT print provider tokens, sync tokens, raw provider payloads,
  private descriptions, or private locations for unauthorized requesters.
- Commands that accept relative times SHOULD normalize output to ISO timestamps
  with timezone context.
- Commands MUST use local ids in output first and provider ids only as
  provenance.
- Event list/search commands MUST require an explicit bounded time range or use
  a documented safe default window. They MUST NOT perform unbounded full-history
  scans by default.

## Commands

### Calendars

```bash
ravi calendars list
ravi calendars create --name "Luis" --timezone America/Sao_Paulo
ravi calendars show <calendar>
ravi calendars share <calendar> --with <subject> --relation reader
ravi calendars disable <calendar>
```

Listing calendars in agent/runtime context MUST return only calendars visible to
the requester.

When `calendars create` runs without an explicit `--owner`, it MUST default to
the active contact actor when one is resolved in runtime context. If no contact
actor is available, it MAY default to the executor agent, then to the local
system owner for direct operator use.

The CLI MUST auto-create or reuse the implicit local source/account needed for
offline calendars. Provider/source management is internal until cloud sync is
introduced.

### Events

```bash
ravi calendars events list --from <time> --to <time>
ravi calendars events read <event>
ravi calendars events create --calendar <calendar> --title <title> --start <time> --end <time>
ravi calendars events update <event>
ravi calendars events cancel <event>
ravi calendars events respond <event> --status accepted
```

`events list` with no explicit calendar MUST scope to the requester's visible
calendars. It MUST NOT list all local calendars in agent/runtime context.

`events list` MUST require `--from` and `--to` or apply a documented safe
default window. Unbounded recurrence expansion or full-history scans MUST require
explicit diagnostic flags.

`events create`, `events update`, `events cancel`, and `events respond` MUST
create local state or local outbox state before any provider request.

### Availability

```bash
ravi calendars availability --from <time> --to <time>
ravi calendars availability --contact <contact> --from <time> --to <time>
ravi calendars availability --agent <agent> --from <time> --to <time>
```

Availability commands MAY expose free/busy facts when `calendar:free-busy` is
granted. They MUST NOT expose private event details unless `calendar:read` is
also granted.

### Internal Outbox

Calendar writes MAY record local outbox rows for future sync/retry semantics,
but the outbox MUST NOT be exposed as a normal agent/user command in the
offline-only surface.

## Output Shape

JSON output SHOULD include:

- local ids first;
- `calendarId`;
- `accountId`;
- event time range with timezone;
- safe title/description fields based on permission;
- attendee identity ids when authorized;
- provider provenance only when authorized and useful for diagnostics;
- sanitized error codes.

## Acceptance Criteria

- Agents can list and read their authorized calendars through `--json`.
- Agents can create local-only events through the CLI.
- Agents can update/cancel/respond through local outbox semantics.
- Availability can return free/busy without leaking private details.
- CLI failures are sanitized and machine-readable.
- `ravi calendar` MAY remain a compatibility alias, but docs, prompts,
  runbooks, and new agent behavior MUST prefer `ravi calendars`.
- Public registry/OpenAPI/SDK surfaces MUST expose only the offline calendar
  commands, not provider sources or outbox diagnostics.
