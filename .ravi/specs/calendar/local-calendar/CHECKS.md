---
id: calendar/local-calendar
title: Local Calendar Checks
kind: checks
domain: calendar
capability: local-calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Local Calendar Checks

## Schema

- Lazy init creates all calendar tables without provider auth.
- Indexes exist for account, calendar, event time range, provider ids, iCal UID,
  recurrence instance keys, attendee identities, cursor status, and outbox
  status.
- Ordinary event list/search queries expand recurrence only within a bounded
  requested window.
- Calendar tables do not contain provider access tokens or refresh tokens.

## Identity

- Calendar ownership is stored as Ravi owner fields, not only provider owner
  metadata.
- Attendee emails normalize to `platform_identity(channel=email)`.
- Unknown attendee emails do not create canonical contacts directly.
- Agent-owned identities do not merge into human contacts.

## Permissions

- Agent without `calendar:read` cannot read private event details.
- Agent with `calendar:free-busy` sees only availability-safe fields.
- `calendar:write` is required to create or update events in a calendar.
- `calendar:respond` is required to respond to an invite as a participant.
- `calendar:manage` is required to share, disable, or reassign a calendar.
- Stale `calendar_members` rows cannot bypass a denied Permission Provider Runtime check.

## Events

- Event payloads use local ids first.
- Private event details are redacted for unauthorized consumers.
- Trigger messages render safe templates instead of raw JSON by default.
- Trigger messages are authorized against the target agent/session before event
  details are rendered.
- Replayed provider events do not produce duplicate reminders or inbox items.

## Outbox

- Creating an event writes `calendar_events` and `calendar_outbox` before any
  provider request.
- Retrying the same outbox row is idempotent.
- Provider failure preserves a recoverable row with sanitized error code.
- Provider success updates provider provenance without changing local event id.
- Provider version conflicts create recoverable sanitized conflict state instead
  of silently overwriting local or remote changes.

## Suggested Validation Commands

```bash
bun test src/calendar/*.test.ts src/cli/commands/calendar.test.ts
bun run typecheck
bun run build
```
