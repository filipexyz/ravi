---
id: cli/calendar
title: Calendar CLI Decisions
kind: why
domain: cli
capability: calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Calendar CLI Decisions

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
