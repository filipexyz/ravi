---
id: sync
title: "Local-First Sync"
kind: domain
domain: sync
capabilities:
  - event-ledger
  - outbox
  - inbox
  - console-bridge
tags:
  - sync
  - local-first
  - sqlite
  - cloud
  - offline
applies_to:
  - src
  - src/router
  - src/contacts.ts
  - src/runtime
owners:
  - ravi-dev
status: draft
normative: true
---

# Local-First Sync

## Intent

Ravi is local-first. The open-source runtime MUST keep working without Console,
without internet, and without a remote database.

Sync exists to mirror selected local domain events to an authorized remote peer
and apply selected remote events back into local SQLite. It MUST NOT turn
Postgres or Ravi Cloud into a hard dependency for local use.

## Storage Boundary

SQLite remains the primary local store.

Remote sync is a peer/replica mechanism. It MAY provide shared cloud
projections, backup, managed runtime continuity, or Console UI visibility, but
local commands and local agents MUST be able to read/write local state first.

## Data Classes

Every domain that wants sync MUST classify records:

- `local_only`: active runtime handles, provider process state, debounce,
  scratch paths, local-only credentials, transient queues.
- `syncable`: contacts, identity graph, CRM ledgers/projections, tasks,
  selected threads, selected chat/message metadata, tags, artifacts metadata,
  selected runtime traces.
- `remote_owned`: organization membership, billing, cloud entitlements,
  provider credentials, managed runtime leases, remote channel host secrets.
- `ephemeral`: runtime sandbox data that can be discarded.

Only `syncable` data is exchanged through sync.

## Event Ledger

Syncable domains SHOULD expose append-only domain events.

Each local sync event MUST include:

```json
{
  "eventId": "uuid-or-deterministic-id",
  "originInstallationId": "local-installation-id",
  "domain": "crm",
  "eventType": "crm.activity.logged",
  "entityType": "activity",
  "entityId": "crm_activity_...",
  "entityRevision": 12,
  "idempotencyKey": "string",
  "occurredAt": "iso8601",
  "payload": {},
  "evidenceRefs": [],
  "schemaVersion": 1
}
```

Local SQLite projections MAY be updated synchronously before remote sync. Remote
sync MUST replay the event or an equivalent normalized event later.

## Outbox

The local outbox stores sync events that need remote delivery.

Outbox rows SHOULD track:

```text
id
event_id
domain
event_type
entity_type
entity_id
idempotency_key
payload_json
status              -- pending | leased | sent | acked | failed | dead
attempt_count
next_attempt_at
last_error_code
created_at
updated_at
acked_at nullable
```

Retries MUST be idempotent.

Outbox delivery SHOULD send batches ordered by creation time and bounded by both
event count and payload bytes. A sync worker MUST NOT make one remote request
per local row when multiple pending events can be delivered safely together.

Domain producers MAY update local SQLite projections synchronously and append
sync events in the same local transaction when feasible. If that is not
feasible, they MUST preserve enough idempotency metadata to repair or replay the
outbox without corrupting local state.

## Inbox

The local inbox stores remote events that need local application.

Inbox rows SHOULD track:

```text
id
remote_sequence
remote_event_id
domain
event_type
entity_type
entity_id
payload_json
status              -- pending | applied | skipped | failed | dead
created_at
applied_at nullable
```

Applying the same remote event twice MUST be safe.

Inbox application SHOULD also be batched per domain where handlers can preserve
ordering. A failed event MUST NOT force the client to redownload the entire
remote cursor window.

## Conflict Policy

Sync conflicts MUST be handled by each domain.

Generic last-write-wins MUST NOT be the default for identity graph, CRM facts,
CRM tasks, or customer relationship state.

Recommended defaults:

- append-only ledgers dedupe by event id/idempotency key;
- facts use `proposed`, `confirmed`, `rejected`, `superseded`;
- tasks use revisioned status transitions;
- contact profile fields resolve field-by-field with provenance;
- deletes use tombstones until all peers observe them.

## Security

The OSS sync layer MUST NOT contain Ravi Cloud authorization policy. It consumes
public remote contracts and applies local effects.

Remote credentials MUST use the existing cloud auth store and refresh path. Sync
code MUST NOT reimplement token refresh.

Sync MUST NOT upload local secrets, provider tokens, environment files, private
workspace files, or raw credentials.

## Acceptance Criteria

- A user can create CRM data offline and keep working locally.
- Sync can later upload local events without rewriting the local CRM model.
- Remote events can be applied locally through an inbox without requiring direct
  Postgres access.
- Failed sync does not break local runtime execution.
- Domain conflict policy is explicit before a domain becomes syncable.
