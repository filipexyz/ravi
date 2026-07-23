# Permission Explainability / RUNBOOK

## Debug Flow

1. Start from provider-runtime output, stored denial metadata, or audit records.
   Do not reconstruct a separate authorization engine.
2. Use:
   `ravi permissions check --permission <perm> --object-type <type> --object-id <id> --json`.
3. Use materialization output to see provider id, source, snapshot timestamp,
   and capability provenance.
4. For agent-identity denials, distinguish missing executor capability,
   unresolved actor, turn cap, and provider-runtime failure.
5. Recommended fixes should use provider-owned configuration, profile, or tag
   names when known. Do not recommend `full-access` as the ordinary fix.

## Validation

```bash
bun test src/permissions/denials.test.ts src/cli/commands/permissions.test.ts
```
