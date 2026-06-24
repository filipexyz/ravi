# Operator Control / CHECKS

## Runtime Checks

- `authorizePermission({ localOperator: true, ... })` allows through
  `providerId=operator-control`.
- `authorizePermission({ permission, objectType, objectId })` without subject,
  context, capabilities, or `localOperator=true` denies.
- `localOperatorCan(...)` delegates to provider-runtime and returns the
  operator-control decision.
- The default authorization provider chain is:
  - `operator-control`
  - `context-capabilities`
- The default capability materializer chain does not include
  `operator-control`.

## Commands

```bash
bun test src/permissions/provider-runtime.test.ts
bun test src/cli/commands/permissions.test.ts
ravi permissions check --permission view --object-type agent --object-id main --local-operator --json
ravi permissions status --json
ravi doctor --domain permissions --json
```
