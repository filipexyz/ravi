# Resource Visibility / RUNBOOK

## Debug Flow

1. Read:
   `ravi specs get permissions/resource-visibility --mode rules --json`.
2. Determine whether a runtime principal is resolved. If yes, fail closed or
   filter to visible resources.
3. For list/search, unauthorized resources should be absent.
4. For show/get/info/check, hidden existing resources should look missing when
   possible.
5. Check SDK discovery, dynamic app aliases, autocomplete, and UI pickers
   against the same visibility rule as CLI.
6. Direct local CLI with no principal may remain an explicit operator path.

## Validation

```bash
bun test src/apps/permissions.test.ts src/cli/commands/contacts.test.ts src/cli/commands/sessions.test.ts src/cli/commands/agents.test.ts
```
