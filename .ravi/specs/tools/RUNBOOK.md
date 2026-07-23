# Tools / RUNBOOK

## Adding a New Tool Command

1. Add the method to `src/cli/commands/tools.ts` with `@Command` and
   `@CommandAccess` decorators.
2. Add a concrete return schema in `src/cli/commands/operational-return-schemas.ts`.
3. Register the schema via `declareCommandReturns()`.
4. If the command is SDK-public and uses `looseObjectSchema`, add it to the
   weak return-schema baseline in
   `src/sdk/client-codegen/return-schema-quality-baseline.ts`.
5. Run `bun run gen:commands && bun run sdk:generate && bun run sdk:check`.
6. Verify with `bun run typecheck && bun run build`.

## Verifying Safety Invariants

Discovery commands (`list`, `search`, `show`, `manifest`, `schema`, `test`)
MUST NOT call `tool.handler`. Only `invoke` calls the handler.

To verify: inspect `src/cli/commands/tools.ts` and confirm that `tool.handler`
is only called in the `invoke` method.
