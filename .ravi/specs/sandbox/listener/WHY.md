# Sandbox Listener / WHY

## Rationale

### Reuse the gateway's lower layers, not its request handler

`handleGatewayRequest` serves `/_meta/*` and streaming, lets open-scope
routes through unauthenticated and authenticates with an `rctx` bearer. None
of that belongs on an origin reachable through a tunnel. The listener reuses
only `buildRouteTable` (which already drops `cliOnly` commands) and
`dispatch` with `source: "gateway"`: with that source the authority comes
exclusively from the context record threaded in, and a request can never
degrade into the local operator (`resolveCommandAccessAuthority`).

### node:http instead of `Bun.serve`

Two contract points need the raw transport. The Gate assertion is bound to
the raw request target, and `Request.url` is already normalised. And when the
served-jti append fails the contract says "close the connection without a
response"; a `fetch`-style handler must always return a `Response`. node:http
gives `req.url` exactly as received and a socket to destroy. The probe that
decided this also found that under Bun `res.destroy()` after an async gap
still flushes an empty 200, which the Gate would pass on as the daemon's
answer; the listener destroys the socket instead.

### An oversized body is drained before the 413

Answering 413 while the client is still sending leaves the rest of the body
in flight. On a kept-alive connection the server then parses those bytes as
the next request (the probe saw stray empty 400s); if the server closes
instead, the reset can discard the 413 before the client reads it. The
listener therefore drains the body up to a bound, answers with
`Connection: close`, and past the bound destroys the socket. The Gate caps
bodies at 2 MiB itself, so an oversized request here is an anomaly, not a
hot path.

### The grant lives in the run record, never in the request

The plan's step 5 verified an `X-Ravi-Sandbox-Grant` header. The Console
spec moved the grant off the wire (gate SPEC §Gate Request Assertion): an
impostor origin would otherwise learn a bearer grant. The host CLI stores
the grant it received at mint; the listener re-verifies that stored copy on
every request and refuses any request that still carries the header. This is
also why the run record keeps `grant_sha256` after revocation: a late
assertion for a revoked run resolves to the record and fails as
`grant_revoked`, which is what Console expects, instead of `run_unknown`.

### `requireConcreteResource` forced on the dispatched entry

The `tasks` commands declare `resourceId: "taskId"` but not
`requireConcreteResource`, because an operator or a full-access agent
legitimately holds group or wildcard capabilities. Over the listener the
contract is concrete-resource only (ADR 0003 #1, #2): the dispatched registry
entry is a copy with `requireConcreteResource: true`, so a child context can
only ever satisfy `read|mutate:task:<the home task>`. The child never holds
anything else anyway; forcing the flag makes a future widening of the child
fail closed rather than quietly authorize.

### Two contexts, not one

The root snapshots what the agent holds locally; the child is the grant
intersected with it. Issuing the child through `issueRuntimeContext` makes
the intersection a property the registry enforces (a cap the parent lacks
throws) rather than a filter the listener has to remember, gives revocation
a cascade, and caps the child's lifetime at the root's, which is the grant's
`exp`. Dropped caps are recorded, never widened: a Console that mints a cap
the agent lacks learns it from the record, not from a 403 at the first
request.

### The served-jti queue is written first and never purged at start

Console's connector check (tunnels SPEC rule 6) reconciles the jtis the
listener served, any status, with what the Gate admitted. A served response
whose jti never reaches Console looks like an impostor origin. So the queue
row is written before the response, under `executeWrite`, and a failed write
means no response at all; entries leave only after Console acknowledges the
report that carried them, so a restart loses none. The same rows preload the
assertion replay cache, closing the restart window that `issued_before_start`
alone covers only when the clock is trusted.

### Module-owned tables

`sandbox_runs`, `sandbox_served_jtis` and `sandbox_listener_state` are
created by `runs-db.ts` with `CREATE TABLE IF NOT EXISTS`, the pattern of
`src/calendar/db.ts`. Keeping them out of `router-db.ts` keeps the schema
next to the code that owns it and outside the router coverage gate.

### The replay preload keeps each jti for its real `exp`

The verifier accepts an assertion until `exp` + 60 s, and the Gate's `iat`
may run up to 60 s ahead of our clock, so `exp` can reach `servedAt` + 120 s
and acceptance `servedAt` + 180 s. Preloading every served jti until
`servedAt` + 120 s left a hole: an assertion dated 55 s ahead, served, then
replayed at +130 s after a restart at +30 s (`iat` still after the restart,
so `issued_before_start` does not fire) was served twice. The served-jti row
now records the verified `exp`, and the preload keeps it until `exp` + 60 s;
a row without it (written before the column existed, or for a request whose
assertion never verified) is kept for the widest window, `servedAt` + 180 s.

### Host and routing refusals are marked but not queued

Steps 1 and 2 run before any token is read, so anyone who can reach the
loopback port, a local process or a DNS-rebinding page, can send them with
any `X-Ravi-Request-Id`. Queueing them let 2048 such requests push the
Gate-admitted jtis out of the queue and set `jtiOverflow`. They still carry
the marker (the Gate learns the listener answered) but are not queued; the
Gate never admits a request to a foreign `Host` or an unrouted path, so
Console has nothing to reconcile them with. Console spec follow-up: queue and
mark only after the Access JWT verifies.

### Concurrency slots belong to the dispatch, not to the 504

A 504 answers the Gate at 25 s, but the command keeps running: the dispatch
cannot be cancelled once the task write started. Releasing the slot when the
timeout race settled let a second command run alongside the first under
`perRunConcurrency: 1`. The slot is now released in the dispatch promise's
own `finally`, and a request arriving meanwhile is 429. Console spec
follow-up: a listener 504 for a non-idempotent command (`tasks.report`,
`done`, `block`, `fail`) must not be retried as `daemon_offline`; the command
may well have run.

### Repeated headers collapse to the last value

Bun's node:http keeps one value per header name, the last one sent: no
comma join, no array. `singleHeader` therefore cannot see a duplicate, and a
`Host` sent twice is judged by its last line. That is harmless because every
decision that grants anything rests on a signed token bound to the request;
the wire-variant test pins the behaviour so a runtime change is noticed. The
forwarded-grant check looks at the raw header lines instead, so an empty
`X-Ravi-Sandbox-Grant:` is refused like a non-empty one.

### Grants are zeroed on disk and pruned on every start

The stored grant is a bearer credential until it expires. The runs
connection sets `secure_delete = ON` (Bun's bundled SQLite defaults to
`FAST`, which zeroes freed content only when that costs no extra I/O, so not
freed overflow or freelist pages), so the revoke
UPDATE and the prunes overwrite what they free. WAL frames that held the
page before the revoke stay in the `-wal` file until a checkpoint reuses
them. `pruneSandboxRunsAtStart` runs at every daemon start, not only when the
listener is configured, so a run revoked before the listener was turned off
does not keep its contexts or grant; a running listener prunes acknowledged
served jtis every 10 minutes, bounded by the same 10-minute retention, which
covers the 180 s replay window.

### No context key leaves `createSandboxRunAuthority`

The listener loads the child by context id; nothing needs the keys, and a
returned key is one more place a bearer could leak (a log line, an error
report). Root and child come back without `contextKey`.

### Console follow-up: terminal task commands publish sandbox text

`tasks.done`, `tasks.block` and `tasks.fail` publish the sandbox's summary or
reason text into the task's report-to session, where an agent reads it as a
message. That is the same exposure that excluded `tasks.comment` from the
allowlist. Console should consider the same restriction (or a quoting
contract) for these three before they are granted to untrusted sandboxes.

### The tunnel gate is read per request from ravi.db

04b read the drift latch and whether to start the listener once, at daemon
boot. Once cloudflared runs (05a) that is not enough: the drift poller lives
in another process (the PM2 `ravi-gateway` runner, cloudflared's parent), and
Console's drift check says the listener serves nothing until the first
successful poll and nothing once a poll fails. So the runner writes the latch
and `last_poll_at` into `sandbox_listener_state` and the listener evaluates
them on every request, cached at most 1 s: a latch reaches the listener within
a second of the runner writing it, and a runner that died (poller gone,
cloudflared possibly orphaned) closes the gate by itself within 10 s because
its polls stop. The latch is not a `gateway.*` setting: settings writes
restart the listener and `ravi settings set` must not be able to clear it.

### Settings changes restart the listener in place

ADR 0002 #8: `ravi gateway expose` (05b) writes the `gateway.*` settings and
emits `ravi.config.changed`, which carries no payload. The supervisor re-reads
the settings on each event (and every 30 s) and starts, stops or restarts the
listener only when the effective configuration changed, so an expose, a
re-expose with a new port or an unexpose takes effect without a daemon
restart, and unrelated config events cost one settings read.

### Plan items the spec superseded

- No `GET /healthz`: Console listener SPEC step 2 says there is no health
  route; everything but an allowlisted `POST` is 404.
- Revoked and expired runs are 401 `grant_revoked`, not 410 (step 6).
- `Host` must equal the tunnel hostname (421 `host_mismatch`), so
  `gateway.tunnel.hostname` is a required setting.
- Body step: `taskId` is required and must equal the home task (403
  `resource_forbidden`); unknown keys including `cwd` are 400 `body_invalid`;
  wrong types are 400 `argument_invalid`.
- Concurrency caps (2 per run, 8 overall) and the 25 s dispatch timeout
  (504 `timeout`) join the rate limits.
- `X-Ravi-Gate: 1` is a routing marker: without it the request is simply not
  routed (404), it is not an authentication failure.
- "cmd in grant but not in the static allowlist" cannot reach a 403: the
  stored grant would fail re-verification (`cmds_not_allowlisted`) and the
  path is refused at step 2 before any token is read. The test asserts the
  404.
- Errors are `{ error: { code, requestId, source } }`; the dispatcher's own
  envelope passes through unchanged for command results and failures.
