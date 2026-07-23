# CLI / RUNBOOK

## Debug Flow

1. For an agent-consumed command, first try the `--json` path.
2. Check list/search commands for pagination, filters, sorting, or documented
   safe defaults.
3. For public SDK/OpenAPI commands, verify the registry includes an explicit
   typed return contract or marks the command CLI-only.
4. For human output, keep summaries compact and include the next useful command.
5. For commands that scan system history, require an explicit full-scan flag.

## Validation

```bash
bun test src/cli/registry.test.ts src/cli/schema-inference.test.ts src/sdk/client-codegen/codegen.test.ts
bun run typecheck
```
