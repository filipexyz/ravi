---
id: calendar
title: Calendar
kind: domain
domain: calendar
capabilities:
  - local-calendar
tags:
  - calendar
  - agenda
  - local-first
  - identity
  - providers
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

# Calendar

## Intent

Calendar is Ravi's local-first scheduling domain.

The local Ravi runtime MUST expose a normalized agenda model that agents can
read from and write to without treating Google Calendar, Ravi Calendar, CalDAV,
or any other remote provider as the agent source of truth.

The calendar domain MUST let a requester ask for "my agenda" and receive only
events from calendars that requester is authorized to access through Ravi's
identity and permission model.

## Boundary

Ravi owns:

- local calendar accounts and calendar projections;
- normalized events, recurrence metadata, attendees, reminders, and outbox
  state;
- provider-neutral create, read, search, update, cancel, respond, and
  availability behavior for agents;
- local sync cursors, retry, idempotency, and diagnostics;
- permission checks for agent access to calendars and calendar events;
- local events and inbox projections for invites, reminders, and conflicts.

Providers own:

- remote delivery and invite propagation;
- remote provider ids, sync tokens, ETags, page tokens, and provider statuses;
- provider-specific capabilities, rate limits, and conflict semantics;
- provider credentials and refresh tokens through their existing auth systems.

The OSS calendar domain MUST NOT embed Console-only authorization policy,
billing, hosting, organization rules, provider credential custody, or remote
database schema.

## Local-First Rule

SQLite is the source of truth for what agents can inspect, search, cite, and act
on locally.

Remote providers MAY be the source of remote delivery facts. They MUST NOT be
the source of truth for agent-facing agenda state after an event has been synced
or created locally.

Provider outage MUST NOT break local reads, local search over synced data,
local event creation, local updates, local cancel requests, or outbox
inspection.

All agent-initiated writes MUST create local state before remote provider
delivery is attempted.

## Identity Integration

Calendar access MUST start from the requester identity.

When a runtime asks for "my agenda", the implementation MUST resolve the actor
from the available session, agent, contact, and platform identity context before
listing events. It MUST NOT fall back to all local calendars in an agent/runtime
context.

Calendar records SHOULD carry:

- `owner_type`: `contact`, `agent`, `system`, or future owner type;
- `owner_id`;
- `contact_id` when an event participant resolves to a human or organization;
- `agent_id` when an event participant resolves to a Ravi agent;
- `platform_identity_id` when a participant identity is known;
- raw provider addresses and ids as provenance only.

Email attendees are platform identities with `channel=email`. Provider user ids
are provider provenance. A raw email address or provider user id MUST NOT become
a canonical contact by itself.

Unknown or ambiguous participants SHOULD create unresolved identity candidates
through the contacts identity graph write path, not direct contact merges.

## Permission Model

Calendar MUST integrate with Ravi REBAC.

The default object type SHOULD be `calendar`. Provider credentials and provider
sync SHOULD use `calendar-provider`.

Suggested permissions:

- `calendar:read`
- `calendar:search`
- `calendar:free-busy`
- `calendar:write`
- `calendar:respond`
- `calendar:manage`
- `calendar-provider:sync`
- `calendar-provider:manage`

Calendar membership SHOULD support relations such as:

- `owner`
- `reader`
- `writer`
- `manager`
- `free_busy`

Calendar membership MAY be persisted as local rows for listing and diagnostics,
but runtime authorization MUST be enforced through the permissions/REBAC
boundary. A local membership row MUST NOT bypass a denied permission check.

An agent with no relation to a private calendar MUST NOT read event details from
that calendar. If free/busy access is granted, the agent MAY see availability
blocks without title, description, location, attendees, or private metadata.

Existing permanent permissions MUST keep their meaning. New calendar grants MAY
be temporary if the permissions subsystem supports expiration, but expiration is
not required by this calendar spec.

## Public Surface

The agent-facing CLI SHOULD evolve toward local-first commands:

```bash
ravi calendar accounts list
ravi calendar accounts create
ravi calendar accounts sync <account>
ravi calendar calendars list
ravi calendar calendars create
ravi calendar calendars show <calendar>
ravi calendar calendars share <calendar>
ravi calendar events list --from <time> --to <time>
ravi calendar events read <event>
ravi calendar events create --calendar <calendar> --title <title> --start <time> --end <time>
ravi calendar events update <event>
ravi calendar events cancel <event>
ravi calendar events respond <event> --status accepted
ravi calendar availability --from <time> --to <time>
ravi calendar outbox status
```

All commands consumed by agents MUST support `--json`.

Provider-specific operations SHOULD live under explicit provider surfaces or
provider account commands. Agent-facing read/write paths SHOULD go through the
local calendar and local outbox.

## Events

The local calendar domain SHOULD emit normalized events for triggers, inbox, and
agents:

- `ravi.calendar.event.created`
- `ravi.calendar.event.updated`
- `ravi.calendar.event.cancelled`
- `ravi.calendar.invite.received`
- `ravi.calendar.response.updated`
- `ravi.calendar.reminder.due`
- `ravi.calendar.conflict.detected`
- `ravi.calendar.outbox.failed`
- `ravi.calendar.provider.sync.failed`

Events MUST carry local ids first and provider ids as provenance. Events MUST
NOT expose provider tokens, remote sync tokens, private descriptions, private
locations, private attendee lists, or raw provider payloads unless the consumer
is explicitly authorized for that calendar and the delivery path is local-only.

Calendar trigger delivery MUST authorize the target agent/session against the
source calendar before rendering event details. If the target is not authorized
for details, the trigger MUST either suppress delivery or render only
free/busy-safe fields when `calendar:free-busy` is granted.

Calendar trigger templates SHOULD render a safe human-readable message instead
of raw JSON by default.

## Relationship To Inbox And Triggers

Inbox is Ravi's local attention and triage surface. It MUST NOT be the durable
calendar source of truth.

Calendar MAY project actionable items into inbox, such as:

- invite requiring response;
- upcoming reminder requiring attention;
- conflict requiring resolution;
- failed provider sync requiring operator action.

Those inbox items MUST point back to local calendar ids. Durable event content,
recurrence state, attendee state, provider provenance, and outbox state belong
to the calendar domain.

Triggers MAY consume calendar events directly. A trigger-created message MUST
include a header identifying that the message came from a trigger and the event
subject that produced it.

## Acceptance Criteria

- Agents can create, list, read, update, cancel, and respond to local calendar
  events through provider-neutral commands.
- "My agenda" resolves through identity and never lists unauthorized calendars
  by default.
- Calendar permissions are enforced through REBAC object scopes.
- Provider sync is optional and best-effort.
- Duplicate provider events do not create duplicate local events.
- Recurring events and instances have stable local identities.
- Calendar events can project safe actionable items into inbox without inbox
  becoming the source of truth.
- Provider credentials, sync tokens, private descriptions, and raw provider
  payloads are not logged or published in unsafe events.
