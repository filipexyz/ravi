# Delegation / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get permissions/delegation --mode rules --json`.
2. Resolve actor, executor agent, surface/chat, automation or system actor, and
   requested action/object.
3. Check the executor agent ceiling before considering delegated overrides.
4. Apply actor and surface constraints by intersection, with explicit denies
   taking precedence.
5. Treat unresolved actors as zero authority.
6. Label break-glass separately from normal delegated authority in traces and
   audit.

## Validation

```bash
bun test src/permissions/delegation.test.ts src/permissions/capability-context.test.ts
```
