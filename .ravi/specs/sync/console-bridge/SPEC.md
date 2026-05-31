---
id: sync/console-bridge
title: "Console Sync Bridge"
kind: capability
domain: sync
capability: console-bridge
tags:
  - sync
  - console
  - cloud-auth
  - data-plane
applies_to:
  - src/cloud-auth
  - src/cli/commands
  - src/daemon.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Console Sync Bridge

## Intent

The Console Sync Bridge is the optional OSS-side bridge that moves local-first
sync events between local SQLite and Ravi Console's public Data Plane contract.

It MUST keep policy in Console and plumbing in OSS.

## Boundary

The bridge owns:

- reading local outbox rows;
- authenticating with existing cloud auth credentials;
- uploading events to Console Data Plane endpoints;
- polling or receiving remote events;
- writing remote events to local inbox;
- acknowledging delivered/applied events;
- backoff and retry.

The bridge MUST NOT own:

- Console organization authorization;
- billing or quota policy;
- provider credential custody;
- cloud conflict policy;
- remote Postgres schema;
- managed runtime lease policy.

## Authentication

The bridge MUST reuse `src/cloud-auth/client.ts` and the existing credential
store at `~/.ravi/cloud-auth/credentials.json`.

It MUST NOT implement an independent token refresh flow.

## Transport

The bridge SHOULD use HTTP Data Plane endpoints exposed by Console.

Initial endpoints SHOULD be shaped as:

```text
POST /api/cli/sync/events
GET  /api/cli/sync/events?cursor=...&domain=...
POST /api/cli/sync/ack
```

Endpoint names MAY differ if the Console spec finalizes different paths, but
the semantics MUST remain event upload, cursor download, and ack.

## Event Upload

Upload requests MUST include:

- local event id;
- local installation id;
- domain;
- event type;
- entity type and id;
- idempotency key;
- schema version;
- payload;
- evidence refs;
- local occurred timestamp.

The bridge MUST treat network errors and 5xx responses as retryable. Validation
errors and authorization errors SHOULD mark the row failed or dead with a safe
error code.

## Remote Download

Download MUST be cursor-based and paginated.

The bridge MUST not request all organization data by default. Domain filters,
project filters, and cursor windows are required for efficient local sync.

## Application

Remote events MUST be written to local inbox before domain handlers mutate local
projections.

Applying a remote event MUST be idempotent. If a handler is missing, the event
stays pending or failed instead of being dropped.

## Acceptance Criteria

- Console sync can be disabled with no effect on local Ravi behavior.
- The bridge can upload a local CRM event with idempotent retry.
- The bridge can download a remote event and queue it locally for application.
- Authorization failures do not leak bearer tokens or remote policy details.
- The bridge contains no proprietary Console policy.
