---
id: calendar
title: Calendar Runbook
kind: runbook
domain: calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Calendar Runbook

## Inspect Local Calendars

```bash
ravi calendar accounts list --json
ravi calendar calendars list --json
ravi calendar events list --from now --to +7d --json
```

## Debug "My Agenda" Leaks

1. Identify the runtime agent/contact/platform identity for the request.
2. List calendars visible to that identity.
3. Check Permission Provider Runtime relations for every returned calendar.
4. Confirm no fallback path returned all calendars because identity context was
   missing.
5. Inspect event payloads for provider ids or private fields that should have
   stayed redacted.

## Debug Provider Sync

1. Inspect `calendar_sync_cursors` for the affected account/calendar.
2. Inspect `calendar_outbox` for failed or dead rows.
3. Confirm provider errors are sanitized.
4. Replay a single provider page/event and verify local idempotency.
5. Confirm cursor advancement happens only after local ingest commits.

## Debug Inbox Projection

1. Read the source calendar event.
2. Confirm the projection dedupe key.
3. Check whether the event should be actionable.
4. Confirm inbox item metadata points to local calendar ids, not remote provider
   ids.

## Debug Trigger Redaction

1. Identify the trigger target session and agent.
2. Check whether that agent has `calendar:read` for the source calendar.
3. If only `calendar:free-busy` is granted, confirm the rendered message omits
   title, description, location, attendees, organizer, and provider payload.
4. If neither permission is granted, confirm delivery was suppressed or failed
   closed with a sanitized reason.
