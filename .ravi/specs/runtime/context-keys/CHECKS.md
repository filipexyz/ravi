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
- `bun test src/runtime/runtime-request-context-lifetime.test.ts src/runtime/runtime-request-builder.context-key.test.ts`
  MUST verify a 90-minute active turn, unchanged key/capabilities, no new grants,
  revocation on authority reduction/actor block, no resurrection, no extension
  of child credentials, cleanup on completion/abort and isolation from rotation.
- The lifetime regression MUST exercise retained host authorization after
  rotation, redundant grants under an existing wildcard, narrowed relays after
  individual caller-grant removal, and cascading revocation through real
  `shutdownRuntimeStreamingSession` before terminal cleanup removes listeners.
- Normal completion followed by session reset MUST revoke surviving children
  and grandchildren without revoking unrelated sessions; ordinary launch
  reclamation with `cascade: false` MUST preserve those children.

- `src/runtime/runtime-request-context.test.ts` checks a CLI child cannot erase host lineage with custom metadata and impersonate a human root turn for bootstrap/relay authority.
- `src/router/router-db.contexts.test.ts` checks explicit and unnamed withdrawal
  survive subsequent terminal cleanup for root and cascaded child contexts.
