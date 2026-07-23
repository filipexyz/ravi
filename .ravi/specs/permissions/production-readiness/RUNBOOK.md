# Permissions Production Readiness / RUNBOOK

## Debug Flow

1. Read:
   `ravi specs get permissions/production-readiness --mode rules --json`.
2. Run the provider-runtime, delegation, capability-context, and permission CLI
   tests.
3. Compare direct checks, materialized capability checks, and explain output for
   the same generated cases.
4. Verify recovery paths do not depend on an agent retaining `admin system:*`.
5. Run `ravi doctor --domain permissions --json` and inspect active historical
   admin or `agent-runtime` context findings.

## Validation

```bash
bun test src/permissions/provider-runtime.test.ts src/permissions/delegation.test.ts src/permissions/capability-context.test.ts src/cli/commands/permissions.test.ts
ravi doctor --domain permissions --json
```
