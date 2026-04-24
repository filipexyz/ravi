# Restart Context Preservation / CHECKS

## Checks

- `bun test src/cli/commands/daemon.test.ts`

## Regression Scenarios

- Runtime session calls restart -> notice returns to same session.
- Slash command calls restart -> CLI receives transparent context.
- Child restart process has no context -> existing parent context is preserved.
- Direct CLI restart outside any session -> fallback behavior remains allowed.
