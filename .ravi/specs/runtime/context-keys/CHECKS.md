# Runtime Context Keys / CHECKS

## Checks

- Every new provider dispatch MUST issue an invocation-scoped `turn-runtime`
  context with `metadata.authorityMode=agent-identity`.
- New dispatch MUST NOT create or reuse `agent-runtime` contexts for active
  authorization.
- Child context keys MUST derive from the active `turn-runtime` context and
  MUST NOT bypass `resolveRuntimeContext`.
- External inbound turns with unresolved human actor identity MUST fail closed
  with no materialized tool, executable, CLI, session, or contact authority.
- Daemon bootstrap admin detection MUST only consider `admin-bootstrap`
  contexts.
- `bun test src/runtime/context-registry.test.ts src/runtime/runtime-request-context.test.ts src/cli/commands/context.test.ts`
  SHOULD pass after changing context-key behavior.
