---
id: devin/sessions
title: "Devin Sessions"
kind: capability
domain: devin
capability: sessions
capabilities:
  - create
  - sync
  - message
  - attachments
  - pull-requests
  - lifecycle
tags:
  - devin
  - sessions
  - external-runs
  - artifacts
applies_to:
  - src/cli/commands
  - src/artifacts
  - src/tasks
owners:
  - ravi-dev
status: draft
normative: true
---

# Devin Sessions

## Intent

Devin sessions are external work records controlled through `ravi devin sessions`.

Ravi should make them operationally useful by linking each remote session to local origin context, syncing progress, and preserving outputs as artifacts.

## Local Model

The implementation SHOULD persist a local record for each remote session in Devin's dedicated SQLite database.

Required fields:

- `id`: local stable id.
- `devin_id`: canonical API session id with the `devin-` prefix.
- `org_id`: Devin organization id.
- `url`: remote Devin UI URL.
- `status`: latest remote status.
- `status_detail`: latest remote status detail when present.
- `title`: remote title when present.
- `tags`: remote tags.
- `origin_type`: `cli`, `task`, `project`, `prox_run`, or `runtime_tool`.
- `origin_id`: local id for the origin.
- `origin_session_name`: Ravi session that requested the handoff when available.
- `agent_id`: Ravi agent that requested the handoff when available.
- `created_at`, `updated_at`, `last_synced_at`.
- `metadata_json`: provider-specific raw metadata without secrets.

Optional fields:

- `task_id`
- `project_id`
- `prox_run_id`
- `playbook_id`
- `snapshot_id`
- `structured_output_json`
- `pull_requests_json`
- `last_message_cursor`

## Lifecycle

1. Caller asks Ravi to create a Devin session.
2. CLI validates auth, org id, allowed options, and explicit source context.
3. CLI calls Devin `POST /sessions`.
4. Ravi stores the returned remote identity, URL, status, and local provenance.
5. Ravi emits/records a local event such as `devin.session.created`.
6. Sync polls `GET /sessions/{devin_id}` and `GET /sessions/{devin_id}/messages`.
7. Attachments are listed through `GET /sessions/{devin_id}/attachments`.
8. Durable outputs are registered as artifacts.
9. If status/detail requires user attention, Ravi reports it to the origin session/task.
10. Termination and archive actions require explicit CLI calls.

## ID Normalization

The Devin API may return `session_id` without the `devin-` path prefix in list/get responses.

Ravi MUST normalize stored and displayed session ids to the canonical API form:

```text
devin-<session_id>
```

Commands MAY accept either the raw id or the canonical prefixed id, but all stored records and follow-up API calls MUST use the canonical prefixed id.

## Status Semantics

Remote status MUST remain provider status. Do not rewrite it into Ravi runtime status.

Expected status values include:

- `new`
- `creating`
- `claimed`
- `running`
- `exit`
- `error`
- `suspended`
- `resuming`

Expected status details include:

- `working`
- `waiting_for_user`
- `waiting_for_approval`
- `finished`
- `inactivity`
- `user_request`
- `usage_limit_exceeded`
- `out_of_credits`
- `out_of_quota`
- `no_quota_allocation`
- `payment_declined`
- `org_usage_limit_exceeded`
- `error`

## Notification Rules

Ravi SHOULD notify the origin session when:

- a session is created;
- a session becomes `waiting_for_user`;
- a session becomes `waiting_for_approval`;
- a session reaches `finished`;
- a session reaches `error`;
- a session is suspended for usage/quota/payment reasons;
- a new PR or attachment appears.

Ravi SHOULD NOT spam every poll result. Polling updates MUST be deduplicated by status, status detail, message event id, attachment id, and PR URL.

## Artifacts

Each synced output SHOULD become an artifact when it is durable and useful later.

Artifact candidates:

- session URL;
- structured output;
- pull request URL/state;
- attachment metadata;
- downloaded attachment file when safe;
- generated summary of the session;
- final sync report.

Artifact provenance MUST include:

- `provider: devin`;
- `devin_id`;
- local session record id;
- origin type/id;
- sync timestamp;
- source endpoint or sync command.

## CLI Contract

Initial commands:

- `ravi devin sessions create --prompt <text> [--title <text>] [--tag <tag>] [--task <id>] [--project <id>] [--prox-run <id>] [--playbook <id>] [--max-acu <n>|--no-max-acu-limit] [--json]`
- `ravi devin sessions list [--status <status>] [--tag <tag>] [--json]`
- `ravi devin sessions show <local-id|devin-id> [--json]`
- `ravi devin sessions messages <local-id|devin-id> [--sync] [--json]`
- `ravi devin sessions send <local-id|devin-id> <message> [--as-user <id>] [--json]`
- `ravi devin sessions attachments <local-id|devin-id> [--download] [--json]`
- `ravi devin sessions sync <local-id|devin-id> [--artifacts] [--json]`
- `ravi devin sessions terminate <local-id|devin-id>`
- `ravi devin sessions archive <local-id|devin-id>`
- `ravi devin sessions unarchive <local-id|devin-id>`

## Safety

- CLI output MUST redact tokens, service user ids when not needed, and secret values.
- Session creation MUST make expensive controls explicit: high configurable ACU defaults, ACU overrides, playbooks, repositories, and secret ids.
- Low ACU ceilings MUST be opt-in. Ravi MUST NOT hide a low default under a generic `create` command.
- Automatic sync MUST use backoff and cursor pagination.
- `send` MUST show whether the remote API may resume a suspended session.
- Destructive actions MUST require explicit session id and should not operate on broad filters.

## Validation

Expected future tests:

- API client request construction.
- CLI argument parsing and redaction.
- Local persistence upsert/idempotency.
- Cursor-based message sync.
- Attachment artifact registration.
- Status notification deduplication.
- Error mapping for 401/403/404/429/5xx.
