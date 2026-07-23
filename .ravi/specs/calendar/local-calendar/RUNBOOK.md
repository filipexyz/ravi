---
id: calendar/local-calendar
title: Local Calendar Runbook
kind: runbook
domain: calendar
capability: local-calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Local Calendar Runbook

## Inspect Local State

```bash
ravi calendars list --json
ravi calendars events list --from now --to +7d --json
```

## Create A Local Event

```bash
ravi calendars events create \
  --calendar <calendar-id> \
  --title "Follow-up" \
  --start "2026-06-05T14:00:00-03:00" \
  --end "2026-06-05T14:30:00-03:00" \
  --json
```

## Verify Permission Isolation

1. Resolve requester contact/agent identity.
2. List calendars visible to that requester.
3. Check every returned event belongs to an authorized calendar.
4. Repeat with an agent that only has `calendar:free-busy`.
5. Confirm private fields are redacted.

## Replay Provider Event

1. Import the same provider event twice.
2. Confirm the same local `calendar_events.id` is updated.
3. Confirm attendees and reminders are replaced or merged idempotently.
4. Confirm inbox projection dedupe prevents duplicate attention items.

## Debug Recurrence

1. Query a bounded window with `ravi calendars events list --from ... --to ...`.
2. Confirm only occurrences inside the requested window are expanded.
3. Confirm each occurrence has a stable local instance key.
4. Confirm cancelled/overridden instances do not duplicate the base series.

## Debug Provider Conflict

1. Inspect the failed `calendar_outbox` row.
2. Inspect the corresponding `calendar_sync_conflicts` row.
3. Confirm conflict snapshots are sanitized.
4. Resolve by retrying, accepting remote, accepting local, or marking ignored
   according to the future conflict-resolution command.
