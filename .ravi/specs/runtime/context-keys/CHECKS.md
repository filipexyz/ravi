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
- `src/cli/commands/context.test.ts` checks a public revoke with any reserved
  host completion/rotation reason remains an explicit withdrawal.
- `src/router/router-db.contexts.test.ts` MUST verify active listing for absent,
  zero, expired, exactly-current and future expiry/revocation timestamps, all
  agent/session/kind filter combinations, descending creation order and
  `includeInactive`, while preserving full context records and historical rows.
- The synthetic context-list benchmark MUST materialize and compare every
  returned record, alternate current and legacy query runs, report failures and
  query plans, and use an isolated state directory without production data.
- Launch a relay with an approval origin, then refresh a warm runtime with a different or absent `_approvalSource`; never reuse the launch chat.
- An exact source-less producer must not inherit the session's last chat, even if a stale delegated hint exists.
- Persist approval routing without exposing it as a command source: CLI/gateway implicit media delivery and durable grants must remain scoped to the direct invocation.
- Derived contexts must preserve the approval-only marker even when child metadata tries to remove it.
- `src/runtime/context-key-hash.test.ts` checks the issuer gets the clear key
  and the row holds only its hash, no `rctx_` remains in `contexts`, the
  presented key resolves, the stored hash (with or without its prefix) does
  not, a record read by id has no key, `resolveRuntimeContextById` applies the
  live/expired/revoked rules, and the migration hashes clear rows while their
  holders keep resolving.
  It also checks that a clear key left in a WAL frame is gone from the database
  file and its WAL after the migration (the WAL is truncated).
- `src/runtime/context-key-hash.test.ts` also issues, uses and revokes keys and
  then scans the whole database file and its WAL for those keys.
- `src/adapters/adapter-store.test.ts` checks a session adapter debug snapshot
  never stores the bound key, and that the migration removes a key an older
  release stored there (row and files scanned), even when the connection has
  `secure_delete` off: the migration forces it on for its rewrite and restores
  the previous value.
- `src/router/router-db.contexts.test.ts` checks that the migration leaves no
  fragment of a long clear key in the database file or its WAL when the
  connection has `secure_delete` off, and that the migration puts back the
  connection's setting whatever it was (`OFF`, `ON` or `FAST`).
- `src/adapters/session-adapter-bus.test.ts` checks that events published on
  `ravi.session.<name>.adapter.*` carry the context id and never the bound key.
