---
id: calendar
title: Calendar Decisions
kind: why
domain: calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Calendar Decisions

## Why A Native Calendar Domain

Mail and inbox established the split between durable source domains and the
local attention surface. Calendar needs the same split.

Calendar events have recurrence, attendees, provider provenance, reminders,
responses, privacy, and availability semantics. Keeping those facts in inbox
would turn inbox into a mixed source of truth and make permission enforcement
fragile.

## Why Local-First

Agents need stable access to agenda facts even when a provider is unavailable,
rate-limited, or not yet linked.

Local-first also lets Ravi enrich events with contacts, agents, sessions,
projects, inbox projections, reminders, and follow-up context without forcing
every provider to support those fields remotely.

## Why Identity Is The Central Boundary

Calendar is more sensitive than generic task state because a query like "show my
agenda" can easily leak another user's schedule if the system falls back to a
global list.

The calendar domain therefore treats requester resolution and Permission Provider Runtime filtering as
part of the core read path, not as an optional UI concern.

## Why Providers Are Adapters

Google Calendar, Ravi Calendar, CalDAV, and future providers have different
models for recurrence, attendees, reminders, and conflict state. Ravi needs a
provider-neutral local model first, then adapters that map provider facts into
that model.

This keeps the local runtime usable without cloud/provider dependencies and
keeps provider-specific logic out of `bot.ts`, launchers, and generic request
builders.

## Alternatives Rejected

- Treating Google Calendar as the primary source of truth: rejected because it
  breaks local-first behavior and makes provider outage a runtime outage.
- Storing calendar items only in inbox: rejected because inbox is a projection
  and cannot safely own recurrence, attendees, and permissions.
- Using raw email addresses as owners: rejected because Ravi already has a
  contacts identity graph and must avoid direct contact merges from provider
  identifiers.
