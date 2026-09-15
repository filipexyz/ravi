---
id: cli/calendar
title: Calendar CLI Decisions
kind: why
domain: cli
capability: calendar
status: active
normative: false
owners:
  - ravi-dev
---

# Calendar CLI Decisions

## Why The Brake Covers share/cancel/respond But Not create/update

The brake criterion is external or irreversible effect on OTHER people, not
"mutation". `calendars share` exposes agenda data to another subject the moment
the membership row lands. `events cancel` and `events respond` are messages
addressed to attendees/organizer once a provider adapter delivers their outbox
rows — cancel cannot be un-sent, and a response commits the agent's answer.

`events create` and `events update` were inspected for the same risk and left
unbraked: today they only write local SQLite state plus a local outbox row.
There is no provider sync adapter (`sources sync` reports
`adapter_not_started` for non-local providers), no outbox consumer, and `local`
provider rows are born `acked` — so creating an event with attendees dispatches
NO invite. Provider delivery is a separate future step; if it ships, the brake
decision for create/update with attendees must be revisited (recorded in the
SPEC's write classification table).

Dry-run plans identify the local calendar/event row and material effect, but do
not repeat agenda content or personal recipient identity. Share uses a stable
pseudonymous `memberRef`; respond may preserve a non-personal local agent id.
Presence and count metadata keep the plan useful without turning it into
another copy of the private event.

## Why Suggestions Come Only From Cheap Scoped Lists

`CALENDAR_NOT_FOUND` and `SOURCE_NOT_FOUND` suggest from lists that are both
cheap and already permission-scoped (visible calendars; local sources), so a
typo never leaks names the requester could not list anyway. Events and outbox
rows have no cheap candidate list — events need a bounded time window, outbox
ids are opaque — so those envelopes omit `suggestions` and point at the listing
command through `suggestedAction` instead.

## Why ContractError Must Bypass runCalendarCommand

Every calendar op runs inside `runCalendarCommand`, a legacy catch-all that
wraps any error into a `CloudAuthError` (exit 1). Without an explicit rethrow,
the write brake's exit 3 and the not-found envelopes would be silently flattened
into `PAYLOAD_INVALID` — the same dispatcher-flattening failure the tasks wave
documented, one layer earlier.

## Known Gap: No Dedicated Skill

This wave shipped no `calendar` skill, so the spec and runbook remain the
domain teaching surface.

## Why Provider-Neutral Commands

Agents should ask Ravi for calendar facts, not ask Google Calendar directly.
Provider-neutral commands let local-only calendars, Ravi Calendar, Google
Calendar, CalDAV, and future providers share one runtime surface.

## Why `--json` Is Mandatory

Calendar is expected to be consumed by agents and triggers. Machine-readable
output prevents brittle text parsing and allows permission-aware redaction to be
tested consistently.

## Why Availability Is Separate From Event Reads

Free/busy access is useful and often less sensitive than event detail access.
Keeping availability separate makes it possible to grant scheduling capability
without leaking private agenda content.
