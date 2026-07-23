---
id: calendar/local-calendar
title: Local Calendar
kind: capability
domain: calendar
capability: local-calendar
tags:
  - calendar
  - local-first
  - sqlite
  - outbox
  - identity
  - agents
applies_to:
  - src/calendar
  - src/cli/commands/calendar.ts
  - src/inbox
  - src/triggers
  - src/permissions
owners:
  - ravi-dev
status: draft
normative: true
---

# Local Calendar

## Intent

The local calendar is the durable agenda store that Ravi agents use as their
scheduling world model.

It MUST normalize events from local calendars, Ravi Calendar, Google Calendar,
CalDAV, and future providers into one local SQLite model. Providers are
adapters; the local calendar is the source of truth for synced agent-facing
state.

## Non-Goals

- This spec does not implement Console policy or provider credential custody.
- This spec does not require cloud sync or Google Calendar to use local
  calendars.
- This spec does not expose every private event field to every agent.
- This spec does not replace the contacts identity graph.

## Source Of Truth Invariants

- SQLite MUST own local calendar projections.
- Provider sync MUST be optional and best-effort.
- Provider failures MUST NOT break local reads, local search, local writes, or
  outbox inspection.
- All writes that agents initiate MUST create local state before remote delivery
  is attempted.
- Remote provider ids MUST be stored as provenance, not as primary local ids.
- Provider-specific behavior MUST stay behind provider adapters.
- Calendar reads in agent/runtime context MUST be filtered through identity and
  Permission Provider Runtime.

## Data Model

The implementation SHOULD lazy-init a `calendar` schema in local SQLite.

### `calendar_accounts`

Provider account configured for local sync.

Fields:

- `id`
- `provider`: `local`, `ravi-calendar`, `google-calendar`, `caldav`, or future
  provider
- `display_name`
- `status`: `active`, `paused`, `auth_required`, `disabled`
- `default_calendar_id`
- `credentials_ref`
- `capabilities_json`
- `settings_json`
- `created_at`
- `updated_at`

`credentials_ref` MUST point to an existing credential store. It MUST NOT
contain provider tokens.

### `calendar_calendars`

Local calendar projection.

Fields:

- `id`
- `account_id`
- `provider_calendar_id`
- `name`
- `description`
- `color`
- `timezone`
- `role`: `primary`, `secondary`, `shared`, `resource`, `system`, or `unknown`
- `status`: `active`, `paused`, `disabled`, `deleted`
- `visibility`: `private`, `shared`, `public`, or `local_only`
- `owner_type`: `contact`, `agent`, `system`, or future owner type
- `owner_id`
- `is_default`
- `last_synced_at`
- `metadata_json`
- `created_at`
- `updated_at`

The owner fields are authorization facts. Provider calendar ownership is
provenance and MUST NOT replace Ravi ownership.

### `calendar_members`

Provider-runtime-friendly membership projection for calendars.

Fields:

- `id`
- `calendar_id`
- `member_type`: `contact`, `agent`, `system`, or future member type
- `member_id`
- `relation`: `owner`, `reader`, `writer`, `manager`, `free_busy`
- `expires_at`
- `created_at`
- `updated_at`

Membership rows SHOULD be mirrored or checked through the permissions engine.
Temporary membership MAY use `expires_at` when supported by the permissions
system.

Membership rows are not an independent authorization engine. Runtime access
MUST still be evaluated through Ravi permissions and the Permission Provider Runtime, and denied permission
checks MUST fail closed even if a stale membership row exists.

### `calendar_events`

Normalized event record.

Fields:

- `id`
- `calendar_id`
- `account_id`
- `uid`
- `provider_event_id`
- `provider_recurring_event_id`
- `ical_uid`
- `series_id`
- `original_start_at`
- `title`
- `description`
- `description_redaction_status`: `full_local`, `preview_only`, `redacted`, or
  `missing`
- `location`
- `location_redaction_status`: `full_local`, `redacted`, or `missing`
- `status`: `confirmed`, `tentative`, `cancelled`, `draft`, or `unknown`
- `busy_status`: `busy`, `free`, `tentative`, `out_of_office`, or `unknown`
- `visibility`: `default`, `private`, `public`, or `confidential`
- `start_at`
- `end_at`
- `start_timezone`
- `end_timezone`
- `all_day`
- `recurrence_rule`
- `recurrence_json`
- `sequence`
- `etag`
- `organizer_contact_id`
- `organizer_agent_id`
- `organizer_platform_identity_id`
- `creator_contact_id`
- `creator_agent_id`
- `creator_platform_identity_id`
- `safe_payload_json`
- `provider_provenance_json`
- `created_at`
- `updated_at`
- `deleted_at`

The local event id MUST be stable and provider-neutral. A provider id MAY be used
to derive it only if scoped by provider/account/calendar and protected by an
idempotency key.

Recurring event instances MUST have stable local ids. The instance key SHOULD
include series identity and original start time when the provider exposes those
facts.

Agenda queries MUST expand recurrence only inside a bounded requested time
window. The implementation MUST NOT expand unbounded recurring events across
their full lifetime during ordinary list/search operations.

### `calendar_event_attendees`

Normalized participants per event.

Fields:

- `id`
- `event_id`
- `kind`: `organizer`, `required`, `optional`, `resource`, or `informational`
- `response_status`: `accepted`, `declined`, `tentative`, `needs_action`, or
  `unknown`
- `email`
- `normalized_email`
- `display_name`
- `contact_id`
- `agent_id`
- `platform_identity_id`
- `provider_attendee_id`
- `raw_json`
- `created_at`
- `updated_at`

Attendee resolution MUST use the contacts identity graph write/read path.
`raw_json` MUST be bounded attendee provenance, not a raw full provider event
payload and not a credential-bearing object.

### `calendar_event_reminders`

Reminder metadata.

Fields:

- `id`
- `event_id`
- `kind`: `popup`, `email`, `message`, `trigger`, or future kind
- `trigger_offset_ms`
- `trigger_at`
- `status`: `pending`, `sent`, `dismissed`, `failed`, or `disabled`
- `metadata_json`
- `created_at`
- `updated_at`

Reminder delivery SHOULD publish local calendar events or trigger messages. It
MUST NOT mutate event source-of-truth fields.

### `calendar_sync_cursors`

Cursor per account, calendar, provider stream, or provider page.

Fields:

- `id`
- `account_id`
- `calendar_id`
- `provider`
- `cursor_type`
- `cursor_value`
- `watermark_at`
- `status`
- `last_success_at`
- `last_error_code`
- `created_at`
- `updated_at`

Cursor advancement MUST happen only after local ingest commits.

### `calendar_sync_conflicts`

Recoverable conflict records for local/provider divergence.

Fields:

- `id`
- `account_id`
- `calendar_id`
- `event_id`
- `outbox_id`
- `provider`
- `conflict_type`: `etag_mismatch`, `deleted_remote`, `changed_remote`,
  `permission_denied`, or future type
- `local_version`
- `remote_version`
- `status`: `open`, `resolved`, `ignored`, or `dead`
- `resolution`
- `safe_local_snapshot_json`
- `safe_remote_snapshot_json`
- `created_at`
- `updated_at`

Conflict snapshots MUST be safe summaries. They MUST NOT contain provider
tokens, raw provider payloads, private descriptions, private locations, or
private attendees unless the row is stored in a local-only encrypted/redacted
path explicitly approved by implementation policy.

### `calendar_outbox`

Local-first write queue.

Fields:

- `id`
- `account_id`
- `calendar_id`
- `event_id`
- `operation`: `create`, `update`, `cancel`, `delete`, `respond`, or future
  operation
- `idempotency_key`
- `payload_json`
- `status`: `pending`, `leased`, `sending`, `sent`, `acked`, `failed`, or `dead`
- `attempt_count`
- `next_attempt_at`
- `last_error_code`
- `provider_result_json`
- `created_at`
- `updated_at`

Outbox payloads MUST be sanitized before logs, CLI output, trace export, or
trigger events.

### `calendar_event_audit`

Append-only audit for local event lifecycle changes.

Fields:

- `id`
- `event_id`
- `event_type`
- `actor_type`: `contact`, `agent`, `system`, or `unknown`
- `actor_id`
- `payload_json`
- `created_at`

Audit payloads MUST NOT include provider tokens or private provider payloads.

## Idempotency

Provider ingest MUST dedupe by provider/account/calendar/provider event id when
available.

When provider event id is missing or unstable, ingest SHOULD fall back to
provider/account/calendar plus iCal UID, recurring instance key, and sequence.

Repeated provider delivery MUST update the same local event and MUST NOT create
duplicate attendees, reminders, inbox items, or trigger notifications.

## Privacy

Private events MUST preserve privacy across every surface.

Agents without event detail access MAY see only free/busy facts when explicitly
authorized:

- `start_at`
- `end_at`
- `busy_status`
- `calendar_id`
- redacted title such as `Busy`

They MUST NOT see title, description, location, attendee list, organizer,
creator, provider payload, or notes.

Trigger rendering, CLI output, inbox projections, trace export, and logs MUST
all use the same redaction rules. A feature MUST NOT rely on a UI-only redaction
step to protect calendar privacy.

## Inbox Projection

Local calendar MAY project actionable records into inbox items.

Suggested projections:

- invite requiring response;
- reminder due;
- conflict detected;
- provider sync failure requiring action.

Inbox metadata MUST contain local calendar ids first:

- `calendar.eventId`
- `calendar.calendarId`
- `calendar.accountId`
- `sourceDomain: "calendar"`
- safe title or redacted title
- safe time range
- status and priority

Inbox projection payloads MUST NOT include private descriptions, private
locations, full attendee lists, provider tokens, sync tokens, or raw provider
payloads.

## Acceptance Criteria

- Lazy init creates the local calendar schema without provider auth.
- Local calendars and events can be created without remote providers.
- Agent calendar reads are scoped by requester identity and Permission Provider Runtime.
- Recurring event instances have stable local ids.
- Provider replay is idempotent.
- Local writes create outbox rows before provider delivery.
- Provider sync failure does not break local calendar commands.
- Inbox projections point to local calendar ids and never become the event
  source of truth.
