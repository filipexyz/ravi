---
id: calendar/local-calendar/provider-sync
title: Calendar Provider Sync
kind: feature
domain: calendar
capability: local-calendar
feature: provider-sync
tags:
  - calendar
  - providers
  - google-calendar
  - local-first
  - sync
applies_to:
  - src/calendar
  - src/sync
  - src/cli/commands/calendar.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Calendar Provider Sync

## Intent

Calendar provider sync maps remote provider facts into Ravi's local calendar
model and maps local outbox operations back to providers.

Google Calendar SHOULD be the first external provider adapter, but the local
contract MUST support Ravi Calendar, CalDAV, and future providers.

## Provider Boundary

Provider adapters own:

- provider authentication through an existing credential store;
- provider event list/import pages;
- provider event create/update/cancel/respond requests;
- provider-specific recurrence and attendee mapping;
- provider rate-limit and conflict response mapping.

Provider adapters MUST NOT own:

- agent-facing local reads;
- local authorization policy;
- contacts identity graph writes outside the approved contact/identity path;
- inbox item lifecycle;
- generic runtime routing.

## Sync Rules

- Sync MUST be optional and best-effort.
- Provider auth failure MUST mark the account `auth_required` or the cursor
  failed without breaking local reads.
- Cursor advancement MUST happen only after local ingest commits.
- Sync MUST batch pages/events where the provider supports it.
- Provider ids MUST be stored as provenance.
- Provider tokens, refresh tokens, sync tokens, raw payloads, and secrets MUST
  NOT be logged, emitted, or stored outside approved credential, cursor,
  provenance, or redacted local diagnostic fields.

## Import Rules

Provider import MUST:

- create or update `calendar_accounts` and `calendar_calendars`;
- normalize events into `calendar_events`;
- normalize attendees through the identity graph path;
- replace or merge attendee/reminder metadata idempotently;
- preserve provider provenance;
- apply privacy/redaction rules before events, inbox projections, or trigger
  messages are emitted.

## Export Rules

Local outbox export MUST:

- lease bounded batches;
- send provider requests with idempotency where available;
- map provider success back to provider provenance;
- mark retryable provider errors as failed with backoff;
- mark unrecoverable rows as dead only after policy-defined retry exhaustion;
- never delete local event state solely because remote delivery failed.

## Conflict Rules

Provider conflicts MUST fail recoverably.

When a provider reports an ETag/version mismatch, remote deletion, permission
loss, or incompatible recurrence mutation, the adapter MUST create or update
sanitized local conflict state instead of silently overwriting local changes.

Conflict handling MAY later expose explicit commands such as accepting the local
version, accepting the remote version, merging, retrying, or ignoring. Until
that exists, conflicts SHOULD remain visible through outbox/status diagnostics.

## Google Calendar Notes

Google Calendar mapping SHOULD treat:

- Google `id` as provider event id;
- Google `iCalUID` as iCal UID;
- Google `recurringEventId` plus `originalStartTime` as recurring instance
  identity when available;
- Google `etag` and `sequence` as provider version facts;
- Google attendees as email platform identities.

Google Calendar access tokens and refresh tokens MUST stay in the configured
credential store.

## Acceptance Criteria

- Provider import is idempotent for repeated remote events.
- Provider export is idempotent for retried local outbox rows.
- Missing provider auth does not break local calendar reads.
- Cursor movement is transactional with local ingest.
- Provider conflicts create recoverable sanitized conflict state.
- Google Calendar can be added without changing the local calendar schema for
  provider-specific fields beyond provenance/settings JSON.
