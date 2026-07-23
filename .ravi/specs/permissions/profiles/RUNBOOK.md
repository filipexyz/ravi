# Permission Profiles / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get permissions/profiles --mode rules --json`.
2. Identify the profile, member principal or surface, expiration, and provenance.
3. Expand the profile before turn-scoped capability materialization.
4. Compare direct permission checks and equivalent runtime contexts; they must
   agree.
5. Verify revoked or expired memberships stop materializing capabilities.
6. For tag-managed profiles, confirm the tag materializes an explicit membership
   relation before it affects authorization.

## Validation

```bash
bun test src/permissions/provider-runtime.test.ts src/permissions/capability-context.test.ts src/cli/commands/permissions.test.ts
```
