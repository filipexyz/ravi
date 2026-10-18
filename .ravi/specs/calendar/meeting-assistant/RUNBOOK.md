---
id: calendar/meeting-assistant
title: Meeting Assistant Runbook
kind: runbook
domain: calendar
capability: meeting-assistant
status: draft
normative: false
owners:
  - ravi-dev
---

# Meeting Assistant Runbook

## Inspect

```bash
ravi agenda status --json
ravi agenda list --days 7 --json
ravi cron list               # routines are named calendar:<kind>:...
```

## Nothing Is Scheduled

1. `ravi agenda status --json`: there is a connection with `syncEnabled: true`.
2. The login works (`ravi whoami`); without one the runner does nothing.
3. Daemon logs at debug level show the runner tick and any Console error code.
4. A `CALENDAR_SCOPE_MISSING` connection needs the Google connection
   reconnected with calendar access.

## A Routine Ran Twice Or Not At All

1. Look up the key in `calendar_assistant_marks`.
2. A mark without a job means the routine ran or was removed; it is not
   scheduled again by design.
3. A moved meeting gets a new key (start time or briefing time in the key).

## Silence The Assistant

Turn the calendar sync off for the connection in the Console, or run
`ravi agenda settings --sync off`. The next tick plans nothing and removes the
waiting jobs.
