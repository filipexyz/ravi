# Tools Registry / RUNBOOK

## Search Returns No Results

Check that the query terms appear in tool names, descriptions, parameters,
or metadata:

```bash
ravi tools list --json | jq '.items[].name'
```

Search uses simple substring matching. Multi-word queries match each term
independently. Try shorter or broader terms.

## Dry-Run Test Shows Unknown Tool

Verify the tool name matches the registry:

```bash
ravi tools show <name> --json
```

Tool names use underscore format: `group_command` (e.g., `sessions_send`).

## Invoke Fails With Permission Denied

`tools invoke` preserves all runtime authorization. Check:

1. Command access: the calling agent must have the tool's `@CommandAccess`
   grants.
2. Scope: the tool's scope must be satisfied.
3. Skill gate: if the tool has a skill gate, the agent must have the skill
   enabled.

```bash
ravi permissions check agent:<id> execute group:<group>
ravi tools show <name> --json | jq '.tool.metadata.access'
```

## Invoke Produces Different Results Than Direct CLI

`tools invoke` runs through the same handler path as the SDK/runtime. If the
tool depends on runtime context (agent session, NATS), it may behave differently
from a bare CLI call. This is expected behavior, not a bug.
