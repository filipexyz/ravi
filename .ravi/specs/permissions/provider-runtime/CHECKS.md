# Permission Provider Runtime / CHECKS

## Static Checks

- Production authorization call sites use `src/permissions/provider-runtime.ts`.
- `provider-runtime.ts` does not import retired permission engines or direct
  capability evaluators.
- App routers do not execute app permission providers directly.
- Skills and specs document `ravi permissions status/check/materialize` and
  `ravi agents permissions`.

## Runtime Checks

- No-subject/no-context without `localOperator=true` denies.
- Explicit local operator allows through the `local-operator` provider.
- Context snapshots authorize only through `context-capabilities`.
- Agent runtime config materializes through `agent-runtime-permissions`.
- Contact permission tags materialize through `contact-policy-permissions`.
- Default agent visibility migration yields `view agent:*`.

## Commands

```bash
bun test src/permissions/provider-runtime.test.ts
bun test src/cli/commands/permissions.test.ts
bun test src/cli/commands/agents.test.ts
ravi doctor --domain permissions --json
```
