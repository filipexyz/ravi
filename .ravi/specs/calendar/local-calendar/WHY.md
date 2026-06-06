---
id: calendar/local-calendar
title: Local Calendar Decisions
kind: why
domain: calendar
capability: local-calendar
status: draft
normative: false
owners:
  - ravi-dev
---

# Local Calendar Decisions

## Why Calendar Accounts And Calendars Are Separate

An account represents a provider connection. A calendar is an agenda surface
inside that account.

This split lets Ravi model local-only calendars, shared calendars, provider
calendars, and future resource calendars without binding agent permissions to a
provider credential.

## Why Calendar Membership Exists

The mailbox permission model scopes access by mailbox. Calendar needs the same
object-level boundary, but with an additional free/busy relation.

Membership rows make the owner/member model explicit and give the permissions
engine a concrete local object to enforce.

## Why Recurrence Is Stored Locally

Recurring events are common and provider recurrence semantics vary. Ravi needs
stable local series and instance ids so agents can cite, update, and reason
about occurrences without depending on provider-specific ids.

## Why Outbox Instead Of Direct Provider Writes

Agents need deterministic local results: "create this event" should create a
local event and a recoverable sync intent even if Google Calendar is offline,
rate-limited, or unlinked.

Outbox also gives Ravi a single place for retry, idempotency, diagnostics, and
provider conflict handling.
