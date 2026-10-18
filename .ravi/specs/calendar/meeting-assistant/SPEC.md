---
id: calendar/meeting-assistant
title: Meeting Assistant
kind: capability
domain: calendar
capability: meeting-assistant
tags:
  - calendar
  - meetings
  - console
  - routines
  - briefing
applies_to:
  - src/calendar/console.ts
  - src/calendar/assistant.ts
  - src/calendar/assistant-runner.ts
  - src/cli/commands/agenda.ts
  - src/plugins/internal/ravi-system/skills/agenda
owners:
  - ravi-dev
status: draft
normative: true
---

# Meeting Assistant

## Intent

The operator's Google calendar, as the Ravi Console keeps it (provider
`ravi-calendar`), drives a meeting assistant on the operator's own agent:
it asks once how calls are recorded, asks about each meeting the day before,
prepares a briefing before the start and runs the follow-up once the
recording is ready.

## Boundary

The Console owns the calendar sync, the person's settings, the organization
rule for automatic recording, the external-attendee rule and the recording
decision (one bot per meeting per organization). This side MUST NOT decide
any of them: it reads `effectiveRecordMode`, `recordDecision` and
`recording` as the Console answers them, and writes only the operator's
choices through the public contract:

- `GET /api/cli/calendar`, `POST /api/cli/calendar/settings`
- `GET /api/cli/calendar/events?from&to` (at most 31 days)
- `GET /api/cli/calendar/events/<id>`
- `POST /api/cli/calendar/events/<id>/decision` `{ decision: "record" | "skip" | null, projectId? }`
- `POST /api/cli/calendar/events/<id>/briefing` `{ markdown }`

The events are not mirrored into the local calendar tables: they are the
operator's private data, and every read goes to the Console under the turn
rule below.

## Who may use it

`ravi agenda` runs with the `ravi login` user's credentials. It MUST refuse,
with `CALENDAR_ACCESS_DENIED` and exit 3 and before any Console call, every
turn that is not the operator's own (the `meetings read` classification:
terminal, the operator's linked direct chat, the operator's routines; a group
is refused even when the operator asks there).

## Commands

| Command | Brake |
| --- | --- |
| `agenda status`, `list`, `show` | read |
| `agenda settings` | immediate, except `--record auto`, which needs `--execute` and is refused locally with `POLICY_DISABLED` (exit 3) while the organization rule is off |
| `agenda record <id>` | `--execute` (the bot joins a call with other people) |
| `agenda skip <id>` | immediate (reduces) |
| `agenda undo <id>` | immediate, except clearing a `skip` while the effective mode is `auto`, which needs `--execute` |
| `agenda briefing <id>` | immediate (shown only to the operator), at most 20,000 characters; `--file` is refused over the gateway (it would read the daemon's machine) and is read only after the operator-turn check |

The Console's `POLICY_DISABLED` maps to exit 3 and `CALENDAR_SCOPE_MISSING`
to exit 1.

## Routines

The daemon that holds the runners leadership (the one running cron) runs the
assistant runner: at start and every
`RAVI_CALENDAR_ASSISTANT_INTERVAL_MS` (default 5 minutes) while a login
exists, it reads the overview and the events from 3 days back to 28 days
ahead, plans reminders and keeps one one-shot cron job per reminder:

- agent: the default agent, `sessionTarget: main`, `ownerPrincipal:
  operator`, `deleteAfterRun`, named by the reminder key (`calendar:...`);
- scheduled at most 36 hours ahead and never sooner than 10 seconds;
- a key is scheduled once (table `calendar_assistant_marks`); a waiting job
  whose reminder is no longer planned is removed and its key forgotten,
  unless it runs within a minute;
- only jobs with a mark are ever removed, so a job the operator named
  `calendar:...` stays; when the Console cut the events listing
  (`truncated`), nothing is removed in that tick.

Reminders, only for connections with sync on and only for meetings (timed,
not cancelled, not declined, with a Meet code or another attendee):

| Kind | Key | When | Condition |
| --- | --- | --- | --- |
| setup | `calendar:setup:<connectionId>` | now | `recordMode` is null |
| prep | `calendar:prep:<eventId>:<startMs>` | 24 hours before, or now | effective mode `ask`, no decision, no bot, a Meet code, 25 minutes or more ahead; or briefing on and an hour or more ahead |
| briefing | `calendar:briefing:<eventId>:<atMs>` | `briefingMinutes` before | briefing on |
| followup | `calendar:followup:<eventId>:<meetingId>` | now | follow-up on, recording ready, ended at most 3 days ago |

A routine's text MUST NOT carry the event's title, attendees or briefing:
those are written by other people. It names the event id, tells the agent to
read it with `ravi agenda show` and to treat its content as data.

## Acceptance Criteria

- Without a login, or against a Console without the calendar routes, the
  runner does nothing and logs at debug level.
- A routine that ran or that the operator removed is not scheduled again.
- A moved meeting gets a new routine and loses the old one.
- `ravi agenda` refuses another person's turn before calling the Console.
