# Agent Identity Authority / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get permissions/agent-identity --mode rules --json`.
2. Resolve executor agent and compartment, such as chat, DM, automation, or
   workspace default.
3. Verify `agent-identity-permissions` appears in the materializer chain.
4. Check materialized capabilities for the agent identity in that compartment.
5. Confirm unresolved external actors materialize zero authority.
6. Denials from agent-identity turns should recommend grants to the executor
   agent identity, not to an arbitrary contact.

## Validation

```bash
bun test src/permissions/provider-runtime.test.ts src/runtime/runtime-request-context.test.ts
```
