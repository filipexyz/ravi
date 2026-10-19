---
id: cloud/agents
title: Cloud Agents Checks
kind: checks
domain: cloud
capability: agents
status: draft
normative: false
owners:
  - ravi-dev
---

# Cloud Agents Checks

## Client

- The client MUST call only `/api/cli/cloud-agents/...` routes and MUST send the login's bearer token.
- An `AUTH_EXPIRED` answer MUST refresh once and retry the call.
- A run `url` on another origin MUST be dropped.
- Lowercase Console codes MUST map to the same contract codes as uppercase ones.

## Commands

- `cloud key set`, `cloud agents deploy`, `cloud runs start`, `cloud runs reply`, `cloud runs approve` and an enabling `cloud schedules add|update` MUST exit 3 without `--execute` and send no write.
- `cloud key set` MUST read stdin only with `--execute` and MUST never print the key.
- `cloud key set` MUST be refused inside an agent runtime (exit 3).
- `cloud runs approve` MUST be refused on another person's agent turn (exit 3).
- `cloud runs start` plans MUST NOT contain the prompt text.
- `cloud runs outputs --download` MUST refuse to overwrite and MUST keep files inside the folder.
- Every command's `--json` output MUST validate against its `@Returns` schema.

## Agent Definition

- Publish MUST reject a `cloud` block with an unknown key, a credential-like key, a URL with userinfo or query, or an out-of-range value, with `CLOUD_AGENT_DEFINITION_INVALID` (exit 2).
- Install MUST write a valid published block to the new agent's `agent.json`.

## Task Dispatch And Watcher

- `tasks dispatch --cloud` MUST fail with `CLOUD_AGENT_NOT_PUBLISHED` for an agent with no Library definition.
- `tasks dispatch --cloud --execute` MUST send origin `{kind:"task", installationId, sessionName, taskId}` and record the run.
- The watcher MUST make no Console call when no task run is open.
- The watcher MUST relay each pending approval once with the approve command.
- The watcher MUST deliver a terminal run once, mark the task done or failed, then acknowledge it.
- A failed acknowledgement MUST be retried without delivering again.
