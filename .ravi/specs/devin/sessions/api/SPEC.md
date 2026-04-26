---
id: devin/sessions/api
title: "Devin Session API Adapter"
kind: feature
domain: devin
capability: sessions
feature: api
capabilities:
  - api-client
  - authentication
  - pagination
  - polling
  - rate-limits
tags:
  - devin
  - api
  - service-user
  - v3
applies_to:
  - src/cli/commands
  - src/artifacts
  - src/tasks
owners:
  - ravi-dev
status: draft
normative: true
---

# Devin Session API Adapter

## Intent

The API adapter isolates Devin HTTP details from CLI commands and higher-level Ravi workflows.

No Ravi feature should hand-roll Devin fetch calls. All API access should flow through a typed adapter that handles auth, base URLs, request ids, retries, pagination, rate-limit behavior, and redaction.

The adapter does not own persistence. Session persistence belongs to Devin's dedicated local store.

## Configuration

Required:

- `DEVIN_API_KEY`
- `DEVIN_ORG_ID`

Optional:

- `DEVIN_API_BASE_URL`, defaulting to `https://api.devin.ai/v3`.
- `DEVIN_DEFAULT_MAX_ACU_LIMIT`, a high default ceiling for Ravi-created sessions.
- default `create_as_user_id` when service user impersonation is intentionally configured.
- default tags applied to Ravi-created sessions.
- polling interval/backoff caps.

The key is a service-user bearer credential and MUST NOT be printed.

## Endpoint Scope

MVP endpoints:

- `GET /self`: validate credentials.
- `POST /organizations/{org_id}/sessions`: create a session.
- `GET /organizations/{org_id}/sessions`: list sessions.
- `GET /organizations/{org_id}/sessions/{devin_id}`: get session detail.
- `GET /organizations/{org_id}/sessions/{devin_id}/messages`: list messages.
- `POST /organizations/{org_id}/sessions/{devin_id}/messages`: send message.
- `GET /organizations/{org_id}/sessions/{devin_id}/attachments`: list attachments.
- session terminate/archive/unarchive endpoints when implemented.

Deferred endpoints:

- knowledge notes;
- playbooks;
- schedules;
- secrets;
- metrics/consumption;
- enterprise admin.

## Request Rules

- All requests MUST include `Authorization: Bearer <token>`.
- JSON requests MUST include `Content-Type: application/json`.
- The adapter MUST include request context in errors without leaking token or secret payloads.
- The adapter MUST normalize `devin_id` input to the canonical `devin-` path id before calling session-specific endpoints.
- The adapter MUST support cursor pagination for list endpoints that expose `after`, `first`, `end_cursor`, and `has_next_page`.
- The adapter MUST treat 429 as rate limited and retry only when the command explicitly allows retry/backoff.

## Create Session Payload

Allowed MVP fields:

- `prompt`
- `title`
- `tags`
- `playbook_id`
- `max_acu_limit`
- `repos`
- `snapshot_id`
- `secret_ids`
- `attachment_urls`
- `structured_output_schema`
- `create_as_user_id`

`max_acu_limit` SHOULD default from `DEVIN_DEFAULT_MAX_ACU_LIMIT` when configured. The CLI MAY omit `max_acu_limit` only through explicit behavior, such as `--no-max-acu-limit`, or through a visible setup decision.

Every field that can spend quota, expose secrets, or impersonate a user MUST be explicit in CLI options or config. It MUST NOT be silently inferred from ambient context.

## Message Sync

Message sync MUST use cursor pagination when available.

Each synced message SHOULD preserve:

- `event_id`
- `created_at`
- `source`
- `message`

The local sync process MUST be idempotent by remote event id. If a remote event id is missing in a future API response, fallback dedupe MUST use `(devin_id, created_at, source, message hash)`.

## Attachment Sync

Attachment sync MUST preserve:

- `attachment_id`
- `name`
- `source`
- `url`
- `content_type`

Downloading attachments is a separate opt-in action. Listing metadata is safe by default; downloading arbitrary remote URLs is not.

## Error Mapping

The adapter SHOULD map errors into stable local codes:

- `devin.auth.invalid` for 401.
- `devin.auth.forbidden` for 403.
- `devin.session.not_found` for 404 on session endpoints.
- `devin.rate_limited` for 429.
- `devin.validation_failed` for 400/422.
- `devin.server_error` for 5xx.
- `devin.network_error` for transport failures.

## Runtime Boundary

This adapter MUST NOT emit Ravi `RuntimeEvent` directly.

If a future Devin runtime provider is created, it must sit above this adapter and still satisfy the runtime provider contract:

- canonical event normalization;
- exactly one terminal turn event per yielded prompt;
- explicit capability declaration;
- provider-state persistence;
- contract tests.

Until that exists, Devin progress is represented as Devin events/artifacts/tasks/prox run updates, not as active runtime turns.
