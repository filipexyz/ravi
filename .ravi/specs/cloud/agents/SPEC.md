---
id: cloud/agents
title: Cloud Agents
kind: capability
domain: cloud
capability: agents
tags:
  - cloud
  - agents
  - anthropic
  - managed-agents
  - tasks
  - library
applies_to:
  - src/cloud-agents
  - src/cli/commands/cloud-agents.ts
  - src/cli/cloud-agents-contract.ts
  - src/cli/cloud-task-dispatch.ts
  - src/cli/commands/tasks.ts
  - src/library/agent-definitions.ts
  - src/daemon.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Cloud Agents

## Intent

A Library agent definition (`ravi agents publish`) can run as a cloud agent:
the Console compiles it into an Anthropic managed agent and environment and runs
it with the organization's own Anthropic key. `ravi cloud` drives this from the
CLI and `ravi tasks dispatch --cloud` runs a local task there. The Console owns
the provider, the key, budgets, approvals and roles (Console spec
`console/managed-runtime/claude-managed-agents`); this side is a client.

## Non-Goals

- No local execution of cloud runs, no provider SDK, no provider key on disk.
- No TUI and no `ravi eval` for cloud runs.
- No new Console scopes: the `ravi login` session's CLI scopes are enough.

## Console Routes

The client (`src/cloud-agents/client.ts`) calls only these routes under
`/api/cli/cloud-agents`, with the `ravi login` access token, and reads only the
contract's fields from the answers:

```
GET  credential                       -> { credential }
POST credential                       { provider:"anthropic", apiKey, monthlyAlertUsd? }
POST credential/remove
GET  agents?project=                  -> { agents }
POST agents/deploy                    { project, agent, version? } -> 201 { agent, changed, warnings } | 200 unchanged
GET  agents/<id>                      -> { agent }
POST agents/<id>/archive              -> { agent }
POST runs                             { project, agent, prompt, budgetUsd?, repositories?,
                                        trigger?, origin?, idempotencyKey? } -> 201 { run }
GET  runs?project=&agent=<cloud agent id>&status=&cursor=&limit=&origin=installation -> { runs, cursor }
GET  runs/<id>                        -> { run }
GET  runs/<id>/events?after=          -> { events, cursor }
POST runs/<id>/messages               { text }
POST runs/<id>/stop
POST runs/<id>/approvals/<approvalId> { decision, reason? } -> { run }   (messages, stop, delivered too)
GET  runs/<id>/outputs/<outputId>     -> bytes
POST runs/<id>/delivered
GET  schedules?project=               -> { schedules }
POST schedules                        { project, agent, cron, timezone, prompt?, budgetUsd?, enabled? } -> 201 { schedule }
POST schedules/<id>                   { cron?, timezone?, prompt?, budgetUsd?, enabled? } -> { schedule }
POST schedules/<id>/delete            -> { deleted: true, id }
```

- Reads need the `console.projects.read` scope and writes also
  `console.projects.link`; a missing scope is `PROJECT_ACCESS_DENIED`.
- `runs list --agent` resolves a slug or name to the cloud agent id the Console
  filters by.
- An expired access token MUST be refreshed once (or taken from a login another
  process refreshed) and the call retried.
- A run's `url` MUST be kept only when it is on the Console's own origin.
- Output bytes MUST come through the Console, never from a provider URL.
- Console error codes (lowercase or uppercase) map to contract codes:
  `CLOUD_AGENTS_UNCONFIGURED` (1), `CLOUD_AGENTS_NOT_ENABLED` (3),
  `CLOUD_CREDENTIAL_MISSING` (1), `CLOUD_CREDENTIAL_INVALID` (1),
  `CLOUD_AGENT_DEFINITION_INVALID` (2), `CLOUD_AGENT_PROVIDER_UNSUPPORTED` (2),
  `CLOUD_AGENT_REPOSITORY_UNAVAILABLE` (1), `CLOUD_RUN_NOT_ACTIVE` (1),
  `forbidden` -> `CLOUD_AGENTS_FORBIDDEN` (1), `VALIDATION_FAILED` (2),
  `IDEMPOTENCY_CONFLICT` (1), `provider_error` -> `CLOUD_PROVIDER_ERROR` (1,
  retryable); `not_found` becomes the command's own `CLOUD_*_NOT_FOUND`.

## Commands

Every command takes `--json`; project commands take `--project` and otherwise
use the Console scope of the cwd (`CLOUD_PROJECT_REQUIRED`, exit 2, when none).
`agents list` and `schedules list` page the Console's list with `--limit`/`--offset`;
`runs list` follows the Console's `--cursor`.

| Command | Effect | Brake |
|---|---|---|
| `cloud key status` | read the key hint, status and month cost | read |
| `cloud key set --stdin` | send the org's Anthropic key | braked; CLI-only |
| `cloud key remove` | revoke the key | immediate |
| `cloud agents list`, `show <agent>` | read | read |
| `cloud agents deploy <agent> [--version n]` | create or update provider objects | braked |
| `cloud agents archive <agent>` | no new runs | immediate |
| `cloud runs start <agent> "<prompt>" [--budget] [--repo]... [--idempotency-key]` | spend money | braked |
| `cloud runs list`, `show <run>` | read | read |
| `cloud runs follow <run>` | poll events until terminal; `--json` is NDJSON ending with `{type:"run", run}` | read; CLI-only |
| `cloud runs stop <run>` | stop | immediate |
| `cloud runs reply <run> "<text>"` | the run continues and spends | braked |
| `cloud runs approve <run> <approval>` | the run writes as the approver | braked |
| `cloud runs deny <run> <approval> [--reason]` | deny | immediate |
| `cloud runs outputs <run> [--download <dir>]` | list or write files | immediate |
| `cloud schedules list` | read | read |
| `cloud schedules add <agent> --cron [--timezone] [--prompt] [--budget] [--disabled]` | create | braked unless `--disabled` |
| `cloud schedules update <id> ...` | change | braked when the schedule ends up enabled |
| `cloud schedules remove <id>` | delete | immediate |

- `key set` MUST read the key only from redirected stdin and only with
  `--execute`; the key MUST never appear in a plan, output, log or argument.
  It MUST be refused inside an agent runtime (`CLOUD_AGENT_CANNOT_SET_KEY`,
  exit 3).
- `runs start` plans MUST carry `promptChars`, never the prompt text. A run
  started inside an agent runtime has trigger `agent`, otherwise `manual`.
- `runs approve` MUST be refused on an agent turn that is not the operator's
  own (`CLOUD_APPROVAL_NOT_OPERATOR`, exit 3); a missing approval is
  `CLOUD_APPROVAL_NOT_FOUND` and a decided one `CLOUD_APPROVAL_NOT_PENDING`.
- `runs outputs --download` MUST keep every file inside the folder and MUST
  refuse to overwrite an existing file (`CLOUD_OUTPUT_EXISTS`).
- The `agent` sent to the Console is the Library slug (`org/x` and
  `clinica/x` become `x`), or the deployed agent's Library slug.

## Agent Definition

`agent.json` of a Library agent may carry a `cloud` block. Every key is
optional:

```json
{
  "cloud": {
    "model": "sonnet",
    "effort": "high",
    "budgetUsd": 5,
    "environment": {
      "networking": "limited",
      "allowedHosts": ["api.github.com"],
      "packages": { "apt": [], "pip": [], "npm": [] }
    },
    "mcp": { "ravi": true, "servers": [{ "name": "linear", "url": "https://mcp.linear.app/sse" }] },
    "tools": { "webSearch": false, "writes": "ask" },
    "repositories": [{ "repo": "owner/name", "branch": "main" }],
    "schedule": { "cron": "0 9 * * 1-5", "timezone": "America/Sao_Paulo" }
  }
}
```

- `model`: `opus`, `sonnet`, `haiku` or a `claude-*` id; `effort`: `low`,
  `medium`, `high`, `xhigh`, `max`; `budgetUsd`: 0.5 to 200 (default 5);
  `networking`: `limited` or `unrestricted`; `writes`: `ask` or `auto`.
- At most 25 allowed hosts (bare hostnames), 50 packages per manager, 10 MCP
  servers (https, no userinfo, query or fragment; the name `ravi` is reserved)
  and 10 repositories.
- A key that looks like a credential (token, secret, password, api key,
  authorization, cookie) MUST be refused anywhere in the block, as MUST unknown
  keys.
- `ravi agents publish` MUST validate the agent's own `agent.json` block and
  refuse an invalid one with `CLOUD_AGENT_DEFINITION_INVALID` (exit 2) and its
  issues; a valid block goes into the published `agent.json`.
- `ravi agents install` MUST write the block to the new agent's `agent.json`,
  so publishing it again keeps the block. An invalid published block is left
  out (the Console refuses it on deploy).

## Task Dispatch

`ravi tasks dispatch <task> --agent <id> --cloud [--budget usd] [--project p]`
runs a task as a cloud run of the local agent's Library definition.

- The Library item is the one the agent was installed from; otherwise an agent
  definition with the agent's id as slug. With neither, dispatch MUST fail with
  `CLOUD_AGENT_NOT_PUBLISHED` before anything is sent.
- It is braked like other spend. The plan names the task, agent, Library ref,
  project, budget, the session that gets the result, and `promptChars`.
- `--execute` starts the run with trigger `task`, origin
  `{ kind:"task", sessionName, taskId }` (the Console adds the installation of
  the `ravi login` session) and an idempotency key, records it in `ravi.db` (`cloud_agent_task_runs`) and marks the task
  `in_progress` with a progress message. No local assignment is created, so
  restart recovery and checkpoints never prompt a local session for it.
- The session that gets the result is `--report-to`, else the dispatching
  session. The Console requires one: without it dispatch MUST fail with
  `CLOUD_TASK_SESSION_REQUIRED` (exit 2) before anything is sent.
- A task that is done or failed (`CLOUD_TASK_FINISHED`) or already has an open
  cloud run (`CLOUD_TASK_RUN_ACTIVE`) MUST be refused.
- `--budget` and `--project` without `--cloud` are a usage error.

## Watcher

The daemon runs the cloud task watcher. Every 30 s it reads the open rows of
`cloud_agent_task_runs`; with none it MUST NOT call the Console.

For each open run it reads `runs/<id>`, then:

1. Each new pending approval is relayed once to the session as a
   `[System] Inform` carrying `ravi cloud runs approve <run> <approval>
   --execute` and the deny command, and told not to approve on its own.
2. When the run ended, the row is claimed (`active` -> `delivered`) before
   anything is sent; the task is marked `done` (completed) or `failed`
   (failed, stopped, budget exceeded) and the session gets a `[System] Inform`
   with cost, files, the Console link and the result quoted inside
   `<result>...</result>` as untrusted text (tags inside the result are
   neutralized; cut at 12,000 characters).
3. Then it calls `runs/<id>/delivered`. A failed task update or inform reopens
   the claim for the next tick; a failed acknowledgement is retried without
   delivering again. A run the Console no longer knows fails the task.

A result MUST be delivered at most once, also across overlapping ticks.

## Acceptance Criteria

- The client, every command's brake and JSON output, the cloud block rules,
  task dispatch and the watcher are covered by tests against a fake Console.
- `bun run sdk:check` passes with the new commands.
