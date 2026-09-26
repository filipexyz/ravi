# Restart Context Preservation / CHECKS

## Checks

- `bun test src/cli/commands/daemon.test.ts`

## Regression Scenarios

- Runtime session calls restart -> notice returns to same session.
- Slash command calls restart -> CLI receives transparent context.
- Child restart process has no context -> existing parent context is preserved.
- Direct CLI restart outside any session -> fallback behavior remains allowed.
- Caller whose resume is fenced (unsafe or missing snapshot) -> caller still receives a restart notice that MUST carry the restart reason and MUST NOT ask it to continue.
