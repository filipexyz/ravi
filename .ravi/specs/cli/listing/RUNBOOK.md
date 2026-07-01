# CLI Listing Contract / RUNBOOK

## Cron Listing Scope Debugging

### Symptom: agent sees jobs from other agents

Check the resolved scope context:

```bash
ravi cron list --json | jq '.filters'
```

If `filters.scope` is `"all"` or `"all-agents"`, the agent context was not
resolved. Verify:

1. `RAVI_AGENT_ID` is set in the environment, or the command is running inside
   an agent session with a valid context.
2. The `--all-agents` flag was not passed accidentally.

### Symptom: agent sees no jobs

The agent-scoped default filters by `job.agentId ?? getDefaultAgentId()`. If the
job was created without an explicit `--agent` flag and the default agent differs
from the current agent, the job will not appear.

Fix: set the job's agent explicitly:

```bash
ravi cron set <id> agent <current-agent-id>
```

Or list with global scope to find the job:

```bash
ravi cron list --all-agents --json
```

### Symptom: admin agent cannot see all jobs

By design, even admin/superadmin agents default to agent-scoped listing. Use
`--all-agents` explicitly:

```bash
ravi cron list --all-agents --json
```

This is intentional to prevent large global lists in agent contexts. The
permission model is unchanged; `--all-agents` still applies REBAC visibility
filtering via `isScopeEnforced` and `canAccessResource`.

### Symptom: `--agent <id>` returns empty even though jobs exist

Check that the calling agent has visibility into the target agent's resources.
Non-admin agents can only view their own resources.

```bash
ravi permissions check agent:<caller> admin system:*
ravi cron list --agent <target> --all-agents --json
```
