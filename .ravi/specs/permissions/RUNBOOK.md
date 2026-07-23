# Permissions Runbook

## Inspect Active Runtime

```bash
ravi permissions status --json
ravi permissions check --permission execute --object-type group --object-id agents --json
ravi permissions materialize --subject-type agent --subject-id main --json
```

Expected baseline:

- `ravi permissions status/check/materialize` are inspection-only.
- `ravi permissions allow/resolve` are provider-owned orchestration commands
  and require explicit `--apply` to mutate.
- Subject authority materializes through registered providers.
- Agent configuration is stored in `agent.defaults.runtimePermissions`.

## Validate Agent Visibility Migration

1. Materialize the default agent:

```bash
ravi permissions materialize --subject-type agent --subject-id main --json
```

2. Confirm it includes:

```text
view agent:*
```

3. Create a test agent from a runtime context and confirm the creator receives:

```text
view agent:<created-agent-id>
```

4. Run:

```bash
ravi doctor --domain permissions --json
```

The `permissions.agents_visibility_migration` check must pass or report exactly
which agents remain hidden from the default operator agent.

## After A Visibility Denial

1. Confirm command access:

```bash
ravi permissions check --permission execute --object-type group --object-id agents --json
```

2. Confirm resource visibility:

```bash
ravi permissions check --permission view --object-type agent --object-id <agent-id> --json
```

3. If the agent exists but is hidden, fix provider-owned config:

```bash
ravi agents permissions <operator-agent> bootstrap --capabilities view:agent:<agent-id>
```

Use `view:agent:*` only for the default operator agent or an explicitly trusted
operator profile.

## Regression Commands

```bash
bun run typecheck
bun test src/permissions/provider-runtime.test.ts src/permissions/delegation.test.ts src/cli/commands/permissions.test.ts src/cli/commands/agents.test.ts
bun run build:cli
```
