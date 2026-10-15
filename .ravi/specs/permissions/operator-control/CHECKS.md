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
- `isLocalOperatorScope(ctx)` is true only when the caller has neither an
  `agentId` nor a runtime context record. A context record without an agent
  (an orphaned context whose agent was deleted, `agent_id` set to NULL) is not
  the local operator: scope, calendar, mailbox and app gates decide it from
  the record's own capabilities, so an empty record is denied even on
  open-scope groups such as `sessions list`, and a record holding
  `admin:system:*` is allowed by that capability, not by operator fallback.

## Commands

```bash
bun test src/permissions/provider-runtime.test.ts
bun test src/permissions/scope.test.ts src/permissions/authorization-agent.test.ts
bun test src/calendar/access.test.ts src/mailbox/access.test.ts src/apps/permissions.test.ts src/apps/router.test.ts
bun test src/cli/commands/permissions.test.ts
ravi permissions check --permission view --object-type agent --object-id main --local-operator --json
ravi permissions status --json
ravi doctor --domain permissions --json
```
