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
- With an admin default credential in `credentials.json` and
  `RAVI_CONTEXT_KEY` set to an unknown, revoked or expired key, `getContext()`
  returns `{ unresolvedContextKey: true }` (not the admin context), scope checks
  are enforced and deny, and CLI command access denies with "requires a
  resolved runtime principal". With `RAVI_CONTEXT_KEY` unset or blank, the
  default credential is still used
  (`bun test src/cli/command-access.test.ts src/cli/context.test.ts`).
- `bun test src/runtime/context-registry.test.ts src/runtime/runtime-request-context.test.ts src/cli/commands/context.test.ts`
  SHOULD pass after changing context-key behavior.
