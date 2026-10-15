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
- After `getDb()`, `ravi.db` and any `-wal`/`-shm` MUST be `0600`, a new
  `chat.db` MUST be `0600`, a db created by `preparePrivateSqliteFile()` under
  umask `022` MUST be `0600` with its WAL files and no chmod afterwards, and a
  `0644` `ravi.db` MUST be tightened when reopened; symlinks, foreign-owned
  files and the `RAVI_STATE_DIR_KEEP_PERMISSIONS=1` opt-out are left unchanged
  (`bun test src/security/private-files.test.ts src/router/router.test.ts`).
- `RAVI_GATEWAY_URL` accepts `http://127.0.0.1:7777`, `http://localhost`,
  `http://[::1]:1` and any `https://` URL, and refuses with
  `REMOTE_GATEWAY_INSECURE` exit 2 `http://gateway.example`,
  `http://127.0.0.1.evil.com`, `http://0.0.0.0`, `http://10.0.0.5`,
  `HTTP://EXAMPLE` and `http://user@127.0.0.1@evil`
  (`bun test src/cli/remote-gateway.test.ts`). `createInheritedClient` MUST
  refuse the same URLs with `REMOTE_GATEWAY_INSECURE` and make no request
  (`bun test packages/ravi-os-sdk/src/__tests__/inherit.test.ts`).
- With a live listener on `cli-gateway.sock`, a second
  `startHostCliGateway()` MUST return null while the first keeps serving;
  parallel starts on a free or stale path MUST start exactly one gateway and
  leave no temporary socket names; a stale socket is replaced; a regular file
  at the path is refused and left intact; an old gateway's `stop()` leaves a
  successor's socket in place (`bun test src/cli/host-cli-gateway.test.ts`).
