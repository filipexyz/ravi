---
id: calendar/meeting-assistant
title: Meeting Assistant Checks
kind: checks
domain: calendar
capability: meeting-assistant
status: draft
normative: false
owners:
  - ravi-dev
---

# Meeting Assistant Checks

## Access

- `ravi agenda` MUST refuse a turn that is not the operator's own with
  `CALENDAR_ACCESS_DENIED` and exit 3 before any Console request.
- A group turn MUST be refused even when the operator sent it.

## Brakes

- `ravi agenda record` without `--execute` MUST exit 3 with
  `WRITE_REQUIRES_EXECUTE` and send no decision.
- `ravi agenda settings --record auto` MUST need `--execute` and MUST fail with
  `POLICY_DISABLED` (exit 3) while the organization rule is off.
- `ravi agenda skip` MUST apply at once.
- `ravi agenda undo` of a skip MUST need `--execute` only when the effective
  mode is `auto`.

## Routines

- A routine prompt MUST NOT contain the event title, attendees or briefing.
- A reminder key MUST be scheduled at most once, also after its job ran or was
  removed.
- A job MUST NOT be scheduled more than 36 hours ahead or less than 10 seconds
  from now.
- A waiting job whose reminder is no longer planned MUST be removed unless it
  runs within a minute.
- Removal MUST touch only jobs the assistant marked, and MUST NOT happen in a
  tick whose events listing came back `truncated`.
- Only the daemon holding the runners leadership MUST run the assistant.
- Without a login, or when the Console answers 404, the runner MUST do nothing
  and fail no tick.
