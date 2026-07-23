# Operator Control / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get permissions/operator-control --mode rules --json`.
2. Confirm the request is an explicit local operator path with
   `localOperator=true`.
3. Missing subject/context MUST NOT imply operator authority without that flag.
4. Verify `operator-control` authorizes provider-owned management commands only.
5. Confirm it does not materialize runtime capabilities and is not used for
   agent tool, executable, app, or session actions.

## Validation

```bash
bun test src/permissions/provider-runtime.test.ts src/cli/commands/permissions.test.ts
ravi permissions status --json
```
