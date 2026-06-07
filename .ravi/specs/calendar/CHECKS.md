---
id: calendar
title: Calendar Checks
kind: checks
domain: calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Calendar Checks

## Identity And Permissions

- A runtime request for "my agenda" resolves the current actor before listing.
- An agent without `calendar:read` cannot read private event details.
- An agent with only `calendar:free-busy` sees availability without title,
  description, location, attendee list, or private metadata.
- Listing without an explicit owner/calendar does not return every local
  calendar in agent context.
- Calendar attendee emails resolve through `platform_identity(channel=email)`.
- Unknown attendee emails do not create canonical contacts directly.

## Events And Inbox

- Calendar events publish local ids first.
- Unsafe event payloads do not include provider tokens, sync tokens, private
  descriptions, private locations, raw provider payloads, or full attendee
  details for unauthorized consumers.
- Calendar trigger delivery checks the target agent/session before rendering
  event details.
- Unauthorized trigger targets receive no event details, or only free/busy-safe
  fields when explicitly allowed.
- Invite/reminder/conflict inbox items point back to local calendar ids.
- Replayed provider events do not create duplicate inbox items.

## Provider Boundary

- Local event reads work with no provider auth.
- Local event creation writes SQLite/outbox before remote provider delivery.
- Provider sync failures preserve sanitized retry state.
- Provider adapters do not place provider-specific branching in `bot.ts`,
  launcher code, or generic request builders.

## Suggested Validation Commands

```bash
bun test src/calendar/*.test.ts src/cli/commands/calendar.test.ts
bun run typecheck
bun run build
```
