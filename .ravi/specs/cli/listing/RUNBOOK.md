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
filtering via `isScopeEnforced` and `canAccessResource(ctx, owner, "read")`.
`filters.visibility` tells you whether the listing could have been filtered:
`scoped` means jobs of agents the caller cannot view are omitted, `full` means
the caller (superadmin or local operator) sees everything.

### Symptom: `--agent <id>` returns empty even though jobs exist

Check that the calling agent has visibility into the target agent's resources.
Besides its own jobs, an agent sees another agent's jobs only with
`view agent:<target>` (or `view agent:*`); jobs created without `--agent`
belong to the default agent for this purpose. Superadmin sees everything.

```bash
ravi permissions check agent:<caller> view agent:<target>
ravi permissions check agent:<caller> admin system:*
ravi cron list --agent <target> --json
```

### Symptom: `cron disable <id>` says Permission denied for a job I can see

Read visibility (`view agent:<owner>`) does not include write authority.
Mutating another agent's job requires `modify agent:<owner>` (or superadmin).
The denial envelope carries `requiredCapability` and `denialId`; plan the grant
from the ledger entry:

```bash
ravi permissions resolve <denialId> --json
```

If the same command answers `Job not found`, the id is wrong or the job is not
readable by the caller at all (no `view agent:<owner>`).
