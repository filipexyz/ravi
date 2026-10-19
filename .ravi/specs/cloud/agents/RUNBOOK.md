---
id: cloud/agents
title: Cloud Agents Runbook
kind: runbook
domain: cloud
capability: agents
status: draft
normative: false
owners:
  - ravi-dev
---

# Cloud Agents Runbook

## First Run

```bash
ravi cloud key status --json
ravi cloud key set --stdin --execute < ~/secrets/anthropic-key   # owner or admin
ravi agents publish triage --scope clinica --description "Sorts tickets" --execute
ravi cloud agents deploy triage --project clinica --execute
ravi cloud runs start triage "Summarize yesterday's open tickets" --project clinica --execute
ravi cloud runs follow <run>
```

## A Run Waits For Approval

```bash
ravi cloud runs show <run> --json
ravi cloud runs approve <run> <approval> --execute
ravi cloud runs deny <run> <approval> --reason "not now"
```

## A Cloud Task Never Finished

```bash
ravi tasks show <task>
ravi cloud runs show <run> --json
sqlite3 ~/.ravi/ravi.db "SELECT run_id, task_id, state, status, last_error FROM cloud_agent_task_runs WHERE state != 'acknowledged'"
ravi daemon logs | grep cloud-agents:task-watcher
```

- `state = active` with a `last_error`: the watcher could not finish the task
  or inform the session; it retries every 30 s.
- `state = delivered`: the result reached the session and the Console
  acknowledgement is pending.
- No login (`ravi whoami`): the watcher skips until `ravi login` again.
