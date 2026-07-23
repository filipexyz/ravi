# Authenticated Break-Glass / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get permissions/enterprise/break-glass --mode rules --json`.
2. For a privileged path, verify missing agent principal alone denies.
3. Resolve the operator or system principal and reason.
4. Route authorization through `operator-control` or the configured provider.
5. Emit break-glass audit with mode, operator, action, object, reason, source,
   and blast radius.
6. Require second approval when configured blast-radius thresholds are exceeded.

## Validation

```bash
bun test src/permissions/provider-runtime.test.ts src/cli/commands/permissions.test.ts
```
