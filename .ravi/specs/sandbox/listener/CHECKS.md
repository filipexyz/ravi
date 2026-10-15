# Sandbox Listener / CHECKS

## Suites

```bash
bun test src/sandbox-listener/ src/sandbox/ src/sdk/gateway/dispatcher.test.ts src/gateway-expose/
bun run typecheck
bunx biome check src/sandbox-listener/ src/sandbox/ src/daemon.ts
```

No check reaches the network: keys are generated at runtime by
`src/test/sandbox-grant-tokens.ts`, JWKS origins are fakes, NATS is mocked
and the listener binds an ephemeral loopback port.

## Checks

- `startSandboxListener` MUST throw for any host other than `127.0.0.1` and
  for a config without `accessClientId` (`server.test.ts`, "refuses to bind
  anywhere but loopback").
- `readSandboxListenerConfig` MUST report `not_configured` without a port,
  `config_invalid` naming every malformed key, and MUST reject a tunnel
  hostname that is not `<installationId>.…` or carries a port
  (`config.test.ts`).
- A well-formed Gate request for `tasks report` MUST succeed with status
  200, `x-ravi-listener: 1`, a task in `in_progress`, one audit whose
  `contextId` is the run's child and `parentContextId` its root, a bumped
  `request_count`, and one served-jti row with status 200 (`server.test.ts`,
  "serves `tasks report`").
- The listener MUST refuse, before any run is touched and without a token in
  the body: no `X-Ravi-Gate` (404), a foreign `Host` (421), `GET` (404), a
  missing or foreign-key Access JWT and a `common_name` other than the pin
  (401 `access_invalid`), a missing assertion, one signed with the grant key,
  one over another body, one for another installation or over another
  grant's hash, one without `X-Ravi-Request-Id` (401
  `gate_assertion_invalid`), an assertion naming a run with no record (401
  `grant_revoked`) and a forwarded `X-Ravi-Sandbox-Grant` (400
  `body_invalid`) ("refuses every unauthenticated…").
- A replayed assertion MUST be 401 `gate_assertion_invalid`
  (`jti_replayed`) in the same process AND after a restart that keeps the
  start time, proving the persisted queue, not `issued_before_start`, closes
  the window; the queue holds one row for the jti ("a replayed Gate
  assertion…").
- A revoked run and an expired run MUST answer 401 `grant_revoked`
  ("a revoked or expired run").
- A record whose stored grant carries another `jti` MUST be 401
  `grant_revoked` (`run_binding_mismatch`); a stored grant for another
  installation MUST be 401 `grant_invalid` ("binds the request to the stored
  grant").
- `/api/v1/agents/permissions`, `tasks/watch` (CliOnly), `tasks/comment`,
  `_meta/registry`, `tasks/_stream`, `..`, `.`, `//`, `%72`, uppercase, a
  trailing slash, a query, `/healthz` and `/` MUST all be 404 `not_found` on
  the raw wire; a static command outside the grant's `cmds` MUST be 403
  `command_not_allowed` with no audit ("routes only the static allowlist").
- A body naming another task MUST be 403 `resource_forbidden` before dispatch
  ("authorizes the concrete home task only").
- A grant cap the agent lacks MUST be dropped at mint and returned in
  `droppedCaps`; the matching command (`tasks show` without `read`) MUST then
  be denied at dispatch as 403 `resource_forbidden` with a `denied` audit
  ("a grant cap the agent lacks is dropped").
- `cwd`, an unknown field, an array body, invalid JSON and a missing `taskId`
  MUST be 400 `body_invalid`; a `taskId` or option of the wrong type MUST be
  400 `argument_invalid`; a command failure MUST pass through as the daemon's
  own envelope (422 `COMMAND_FAILED`) with the marker; 2 MiB + 1 MUST be 413
  with a complete JSON body after the request was drained, and exactly 2 MiB
  MUST reach the body check ("validates the body").
- `Authorization: Bearer <valid admin context key>` MUST change nothing: 401
  `access_invalid`, no audit ("never reads Authorization").
- A JWKS cold start with the origin down MUST be 503 `jwks_unavailable`,
  marked ("a JWKS cold start").
- Tunnel gate from ravi.db (`server.test.ts`, "the tunnel gate in ravi.db"):
  before any recorded poll every Gate-shaped request MUST be 503
  `tunnel_drift` (reason `no_successful_poll`), marked and queued; a poll
  recorded by another writer MUST open it within 1 s (cache) and not before;
  a last poll older than 10 s MUST close it (`poll_stale`); a latch MUST close
  it (`drift_latched`) even with a fresh poll, until `dbClearTunnelDriftLatch`;
  the listener MUST record `listener.armed` with its port on start and clear
  it on stop.
- A tunnel-gate read that throws MUST refuse 503 `tunnel_drift` ("fail
  closed"); a wrong `Host` (421) or route (404) MUST still be refused first
  and stay unqueued while the gate is closed ("come before the tunnel gate").
- The drift latch MUST NOT be a setting (`config.test.ts`); a latch row that
  does not parse MUST still latch, and the first latch cause MUST be kept
  (`src/sandbox/tunnel-state.test.ts`).
- Settings reload (`supervisor.test.ts`): the supervisor MUST start the
  listener when settings become complete, keep it when nothing changed,
  restart it when any value changed, stop it when settings are removed or
  invalid, retry after a failed start, and reconcile on every
  `ravi.config.changed`; with real settings in ravi.db a
  `gateway.listener.port` change MUST move the listener to the new port with
  the old one closed and no daemon restart.
- The third request in a minute under `perRunPerMinute: 2` MUST be 429
  `rate_limited` with `Retry-After: 1` ("rate limits").
- The served jti MUST be appended for an accepted and for a refused request,
  before the response is written; a request without a request id appends
  nothing; a failing append MUST close the connection with no response and
  leave the queue unchanged ("persists every served jti").
- 04b review regressions (`server.test.ts`, "04b review regressions"; each
  failed on 71f26661):
  - an assertion dated 55 s ahead, served, the listener restarted 30 s later
    and the assertion replayed at +130 s MUST be 401 `jti_replayed`, with the
    command run once; a served row without `assertion_exp` served 170 s ago
    MUST still be preloaded;
  - 2048 requests with a foreign `Host` and a request id MUST be 421 with the
    marker and leave the queue and `jti_overflow_at` untouched; the admitted
    jti survives; routing 404s are not queued, a later 401 is;
  - under `perRunConcurrency: 1` a dispatch that outlives the timeout MUST
    answer 504 and a second request MUST be 429 until the first settles;
  - on the raw wire a repeated `Host` or `X-Ravi-Gate` MUST be judged by its
    last value, and the 421/404 wire variants MUST NOT be queued;
  - an empty `X-Ravi-Sandbox-Grant` MUST be 400 `body_invalid`;
  - the production audit path (no test sink) MUST emit `runId` and
    `requestId`;
  - a running listener MUST prune acknowledged served jtis past retention on
    its timer and keep pending and recent ones.
- `createSandboxRunAuthority` MUST return `root` and `child` without
  `contextKey` and nothing containing `rctx_`; the runs connection MUST run
  with `secure_delete = 1`, and a revoked grant MUST NOT survive in the
  checkpointed database file; the served-jti row MUST record `assertionExp`,
  and an older table MUST gain `assertion_exp` in place (`run-context.test.ts`).
- `createSandboxRunAuthority` MUST issue a `sandbox-run-root` and a
  `sandbox-run` child whose caps are exactly the authorized grant caps, whose
  `expiresAt` is at most the grant's and whose `agentId` is never empty
  (`run-context.test.ts`).
- It MUST drop and record `admin:system:*`, `execute:group:tasks`, a cap for
  another task and a cap the agent lacks; MUST refuse an unknown agent
  (`agent_unknown`), an agent holding `admin:system:*` (`agent_superadmin`),
  `operator` (`agent_invalid`), a malformed run id, `cmds` outside the
  allowlist, an expired grant and a duplicate run (`run_exists`).
- `revokeSandboxRun` MUST revoke root and child, set `revoked_at`, blank
  `grant_jws`, keep `grant_sha256`, and be idempotent; `getLiveSandboxRun`
  and `getLiveSandboxRunContext` MUST return null afterwards.
- `pruneSandboxRunsAtStart` MUST delete expired runs (revoking their
  contexts), keep live runs and never delete an unacknowledged served jti.
- The served-jti queue MUST list oldest first, keep the first row for a
  repeated jti, acknowledge without deleting, prune only acknowledged rows,
  and at 2049 unacknowledged rows drop the oldest and record
  `jti_overflow_at` until cleared.
- `bun run test` MUST include `bun test src/sandbox-listener/` and
  `bun test src/sandbox/` (`package.json`).
- `src/daemon.ts` MUST start the listener only when
  `readSandboxListenerConfig()` is enabled and stop it at shutdown, and MUST
  call `pruneSandboxRunsAtStart()` at every start, before and independent of
  the listener.
