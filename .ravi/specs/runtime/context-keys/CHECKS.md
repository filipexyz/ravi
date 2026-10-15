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
- After `dbCreateContext`, a raw `SELECT context_key FROM contexts` MUST
  contain no `rctx_` value and only `kh1:` digests; the returned record carries
  the plaintext key; `dbGetContext` and `dbListContexts` return the digest;
  `dbGetContextByKey`/`dbGetContextByKeyReadOnly` find the row by the plaintext
  key (returning it as `contextKey`) and return null for the stored digest; a
  legacy plaintext row is found before and after `migrateContextKeysToDigest`,
  which hashes every plaintext row across batches and changes 0 rows on a
  second run; opening the DB alone migrates nothing
  (`bun test src/router/router.test.ts`).
- `createRuntimeContext({ contextKey })` (the `--from-env` import) resolves by
  the plaintext key while storing its digest; revoking a legacy plaintext
  parent after the migration still cascades to its children
  (`bun test src/runtime/context-registry.test.ts`).
- In-place persistence of a turn context keeps the plaintext key in the live
  record, the tool context and `RAVI_CONTEXT_KEY`
  (`bun test src/runtime/runtime-request-context.test.ts`).
- The gateway accepts the plaintext key handed out at issuance as a bearer and
  answers 401 to the stored digest (`bun test src/sdk/gateway/server.test.ts`).
- With a digest row and a legacy plaintext twin of the same key,
  `dbGetContextByKey` and `dbGetContextByKeyReadOnly` return the digest row
  whichever was inserted first, and the plaintext row only once the digest row
  is gone; `migrateContextKeysToDigest` leaves the twin in place and returns
  its context id in `skippedContextIds` (never a key)
  (`bun test src/router/router.test.ts`).
- `ravi doctor` reports `runtime.context_keys_at_rest` as ok with 0 plaintext
  rows; warn with the count, the plaintext context ids (at most 20, with
  `plaintextContextIdsTruncated` when more exist) and a fixHint naming both
  `ravi daemon restart -m "hash context keys"` and
  `ravi context revoke <id>`, and no `rctx_` anywhere in the finding; and skip
  when the count fails (`bun test src/cli/commands/doctor.test.ts`).
- `ravi daemon init-admin-key --from-env` refuses a `RAVI_BOOTSTRAP_KEY`
  shorter than `rctx_` + 24 characters with an error naming the minimum (29)
  and the length received, writes nothing, and still refuses a key without the
  `rctx_` prefix first; a key of a generated key's length imports and resolves
  idempotently (`bun test src/cli/commands/daemon.test.ts`).
