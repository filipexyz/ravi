---
id: cli/calendar
title: Calendar CLI Runbook
kind: runbook
domain: cli
capability: calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Calendar CLI Runbook

## Create A Local Calendar

```bash
ravi calendars create --name "Luis" --timezone America/Sao_Paulo --json
```

## Create And Read An Event

```bash
ravi calendars events create \
  --calendar <calendar-id> \
  --title "Daily review" \
  --start "2026-06-05T10:00:00-03:00" \
  --end "2026-06-05T10:30:00-03:00" \
  --json

ravi calendars events read <event-id> --json
```

## Check Availability

```bash
ravi calendars availability --from now --to +7d --json
```
