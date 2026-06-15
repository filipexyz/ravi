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

`ravi calendar` is the provider-neutral command surface for Ravi's local-first
agenda.

Agents MUST be able to use the CLI to inspect and mutate local calendar state
without knowing which remote provider, if any, backs the calendar.

## General Rules

- Every agent-consumed command MUST support `--json`.
- Commands MUST read and write local SQLite state first.
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

### Accounts

```bash
ravi calendar accounts list
ravi calendar accounts create --provider local --display-name "Luis"
ravi calendar accounts sync <account>
```

`accounts sync` SHOULD enqueue or run provider sync for the account. It MUST NOT
be required for local-only calendars.

### Calendars

```bash
ravi calendar calendars list
ravi calendar calendars create --name "Luis" --timezone America/Sao_Paulo
ravi calendar calendars show <calendar>
ravi calendar calendars share <calendar> --with <subject> --relation reader
ravi calendar calendars disable <calendar>
```

Listing calendars in agent/runtime context MUST return only calendars visible to
the requester.

### Events

```bash
ravi calendar events list --from <time> --to <time>
ravi calendar events read <event>
ravi calendar events create --calendar <calendar> --title <title> --start <time> --end <time>
ravi calendar events update <event>
ravi calendar events cancel <event>
ravi calendar events respond <event> --status accepted
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
ravi calendar availability --from <time> --to <time>
ravi calendar availability --contact <contact> --from <time> --to <time>
ravi calendar availability --agent <agent> --from <time> --to <time>
```

Availability commands MAY expose free/busy facts when `calendar:free-busy` is
granted. They MUST NOT expose private event details unless `calendar:read` is
also granted.

### Outbox

```bash
ravi calendar outbox status
ravi calendar outbox retry
ravi calendar outbox inspect <id>
```

Outbox commands MUST sanitize payloads and errors.

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
