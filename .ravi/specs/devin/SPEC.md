---
id: devin
title: "Devin"
kind: domain
domain: devin
capabilities:
  - sessions
  - handoff
  - artifacts
  - playbooks
  - schedules
tags:
  - devin
  - external-executor
  - remote-sessions
  - cli
applies_to:
  - src/cli/commands
  - src/artifacts
  - src/tasks
  - .ravi/specs/prox
owners:
  - ravi-dev
status: draft
normative: true
---

# Devin

## Intent

`ravi devin` is Ravi's control plane for delegating long-running external work to Devin while keeping Ravi as the owner of routing, tasks, artifacts, approvals, provenance, and user-facing follow-up.

Devin MUST be treated first as an external execution system with remote sessions, not as a Ravi runtime provider. The integration should let Ravi create, inspect, message, sync, archive, and terminate Devin sessions, then bring results back into Ravi as artifacts or task/prox run state.

## Source Facts

Official API references used for this spec:

- https://docs.devin.ai/api-reference/overview
- https://docs.devin.ai/api-reference/common-flows
- https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
- https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session
- https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages
- https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages
- https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-attachments

The current API surface is v3 and organization-scoped for the primary MVP path:

- base path: `https://api.devin.ai/v3/organizations/{org_id}`;
- auth: bearer service-user credential;
- session creation: `POST /sessions`;
- session inspection: `GET /sessions/{devin_id}`;
- message sync: `GET /sessions/{devin_id}/messages`;
- message send: `POST /sessions/{devin_id}/messages`;
- attachment sync: `GET /sessions/{devin_id}/attachments`.

## Product Boundary

- `ravi devin` MUST be a CLI/control-plane integration before it is considered a runtime provider.
- Ravi MUST NOT pretend a Devin remote session is the same thing as a Ravi runtime turn.
- Ravi MUST own provenance, artifacts, task linkage, project linkage, prox run linkage, policy checks, and user-facing summaries.
- Devin owns remote execution, its own workspace/session lifecycle, ACU usage, generated attachments, status, pull requests, playbooks, knowledge notes, and schedules.
- API credentials MUST stay in settings/secrets/env; specs, logs, tasks, and artifacts MUST NOT expose raw token values.

## Why Not Runtime Provider First

Ravi runtime providers are turn-oriented execution adapters. They must emit canonical runtime events and eventually produce exactly one terminal event per yielded turn.

Devin sessions are remote, long-running, API-polled execution units. Their status values include lifecycle states such as `new`, `creating`, `claimed`, `running`, `exit`, `error`, `suspended`, and `resuming`, plus status detail such as `working`, `waiting_for_user`, `waiting_for_approval`, and `finished`.

Those states are useful, but they are not a clean replacement for Ravi's runtime stream contract. Mapping Devin directly to a runtime provider would create fake turn semantics, weak streaming guarantees, and confusing session ownership.

## Integration Points

- Tasks MAY launch a Devin session as an external implementation lane.
- Prox runs MAY launch a Devin session after human approval of a deal.
- Projects MAY link Devin sessions as external work records.
- Artifacts MUST capture durable outputs: session URL, structured output, attachments, PR URLs, generated summaries, and sync reports.
- Runtime MAY later call `ravi devin` as a tool, but the Devin session itself remains external.

## Storage

`ravi devin` MUST use its own SQLite database, not the main router DB.

Current target:

- `getRaviStateDir()/devin.db`

The Devin DB owns:

- local remote-session cache;
- synced message cache;
- synced attachment cache;
- provider-specific sync metadata.

Ravi's main DB remains owner of agents, routes, sessions, contacts, tasks, projects, and generic artifacts.

## Initial CLI Shape

The first namespace SHOULD be:

- `ravi devin auth check`
- `ravi devin sessions create`
- `ravi devin sessions list`
- `ravi devin sessions show`
- `ravi devin sessions messages`
- `ravi devin sessions send`
- `ravi devin sessions attachments`
- `ravi devin sessions sync`
- `ravi devin sessions terminate`
- `ravi devin sessions archive`
- `ravi devin sessions unarchive`

Later namespaces MAY include:

- `ravi devin playbooks`
- `ravi devin knowledge`
- `ravi devin schedules`
- `ravi devin secrets`
- `ravi devin usage`

## MVP

The MVP is complete when Ravi can:

1. Validate Devin auth and org configuration without exposing secrets.
2. Create a Devin session from a prompt with optional title, tags, repo list, playbook, ACU limit, and links to Ravi task/project/prox run.
3. Persist the remote `devin_id`, URL, status, title, tags, origin, and local provenance in Devin's dedicated DB.
4. Poll/sync status, messages, attachments, structured output, and PR data.
5. Register synced outputs as artifacts.
6. Send a follow-up message to an active/suspended Devin session.
7. Terminate or archive a session deliberately.

## ACU Limit Policy

Ravi-created Devin sessions SHOULD use a high configurable ACU ceiling by default.

The default MUST come from configuration, such as `DEVIN_DEFAULT_MAX_ACU_LIMIT`, not from a hidden low constant in code.

If no default is configured, the CLI MUST make the behavior visible before creating a session:

- either omit `max_acu_limit` explicitly;
- or fail with a clear setup message if the command/profile requires a default limit.

CLI overrides:

- `--max-acu <n>` sets the ceiling for that session.
- `--no-max-acu-limit` intentionally omits the ceiling for that session.

Low ACU limits MUST be explicit. Ravi MUST NOT silently cap Devin runs in a way that makes long work fail unexpectedly.

## Out Of Scope For MVP

- Full runtime-provider integration.
- Automatic task completion based only on remote Devin status.
- Broad secret management UI.
- Schedules as production automation.
- Enterprise admin features beyond what is needed to create and inspect organization sessions.
- Deep bidirectional code review workflows.

## Open Decisions

- Whether local persistence should be `devin_sessions` or a generic `external_runs` table.
- Whether `ravi tasks` should expose a direct shortcut like `ravi tasks devin <task>`.
- How aggressive polling should be by default.
- Whether API-created Devin sessions should use `create_as_user_id` when available.
- Which Devin status details should trigger a Ravi notification versus stay as silent sync state.
- The exact production default value for `DEVIN_DEFAULT_MAX_ACU_LIMIT`.
