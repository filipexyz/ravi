---
id: sandbox/listener
title: "Sandbox Listener"
kind: capability
domain: sandbox
capabilities:
  - listener
tags:
  - sandbox
  - gateway
  - daemon
  - cloudflared
  - security
applies_to:
  - src/sandbox-listener/server.ts
  - src/sandbox-listener/config.ts
  - src/sandbox-listener/supervisor.ts
  - src/sandbox/runs-db.ts
  - src/sandbox/run-context.ts
owners:
  - rbbt-sandbox
status: active
normative: true
---

# Sandbox Listener

## Intent

A connected sandbox run calls home through the Console Gate and a Cloudflare
tunnel that ends at cloudflared on the daemon's host. The sandbox listener is
the loopback HTTP origin cloudflared forwards to: it serves exactly the task
commands of the static allowlist, for runs the host CLI created, from the
run's own authority, and refuses everything else. Policy stays in Console;
the listener only verifies and refuses.

The normative contract is Console's `console/sandbox-gateway/listener` SPEC
(with `gate` §Gate Request Assertion, `tunnels` §Host Report and the
capability SPEC §Identifiers). This spec is the OSS mirror; when they
disagree, Console's spec wins and this one is corrected. The stack plan
(`.agent/context/plans`, §04b) predates the Console spec; where the two
differ this spec follows Console (see WHY §Plan items the spec superseded).

The verifiers it composes are specified in `sandbox/grant-verify`; the
cloudflared runner and drift poller that write the tunnel gate it reads are
specified in `sandbox/tunnel-runner` (05a). The host CLI slice that creates
run authority (06b) and the host report (05b) are later slices; this spec
states what they read and write here.

## Vocabulary

- Run record: a `sandbox_runs` row, created only by the host CLI from the
  grant it received at mint and verified. It holds the grant compact JWS, the
  claims the run is bound to (`jti`, `agent`, `task`, canonical `caps` and
  `cmds`, `org`, installation), the two context ids and `expires_at`.
- Run authority: a `sandbox-run-root` context (the home agent's capability
  snapshot) and its `sandbox-run` child (grant caps ∩ local), both bound to
  the run record. The listener dispatches with the child; it never mints.
- Served jti: the `X-Ravi-Request-Id` of a request the listener answered with
  `x-ravi-listener: 1`, any status. Queued in `sandbox_served_jtis` until
  Console acknowledges the host report that carried it.
- Tunnel gate: the drift latch and the last successful `/config` poll, both
  in `sandbox_listener_state` (`tunnel.drift_latch`, `tunnel.last_poll_at`;
  `src/sandbox/tunnel-state.ts`), written by the tunnel runner process and
  read by the listener. Open only when no latch is set and the last
  successful poll is at most 10 s old. Not a setting: a `gateway.*` write
  restarts the listener and `ravi settings set` must not clear a latch.
- Configured Console issuer: `gateway.consoleUrl`, an `https` origin; the
  grant and gate JWKS are fetched from it. Never a value from a request.

## Invariants

### Start

- The listener binds `127.0.0.1` only. Any other host is a thrown error
  with no override.
- It refuses to start without `gateway.access.clientId`, and without any of
  `gateway.listener.port`, `gateway.access.teamDomain`, `gateway.access.aud`,
  `gateway.installationId`, `gateway.consoleUrl`, `gateway.tunnel.hostname`.
  `readSandboxListenerConfig` names every malformed key; the daemon logs them
  and runs without the listener. No port configured means disabled.
- Every daemon start, listener configured or not, runs
  `pruneSandboxRunsAtStart`: it deletes every expired or revoked run record
  (revoking any context still live) and acknowledged served jtis older than
  10 minutes. Unacknowledged served jtis are never deleted at start. While
  the listener runs it also deletes acknowledged served jtis older than 10
  minutes every 10 minutes.
- Served jtis younger than 180 s are preloaded into the single-use assertion
  cache, each kept exactly as long as the verifier could still accept it: its
  recorded assertion `exp` + 60 s, or, for a row without `assertion_exp`,
  `servedAt` + 180 s (60 s assertion lifetime + 60 s skew + 60 s post-`exp`
  grace). A restart therefore never reopens the window, even for an
  assertion the Gate dated up to 60 s ahead of our clock.
- On start it records `listener.armed` `{pid, port, at}` in
  `sandbox_listener_state` and removes it on stop (only its own); the tunnel
  runner starts cloudflared only once that record names the configured port
  and a live pid.
- It owns exactly one `GateAssertionReplayCache` and one `JwksCache` per key
  set (Access certs, gate JWKS, grant JWKS), persisted 0600 under
  `<RAVI_STATE_DIR>/sandbox-listener/`.
- The daemon runs it in process through `SandboxListenerSupervisor` and stops
  it at shutdown; it spawns no child process. The supervisor reconciles at
  boot, on every `ravi.config.changed` and every 30 s: it starts the
  listener when the `gateway.*` settings became complete, stops it when they
  were removed or became invalid, restarts it when any value changed, and
  leaves it alone otherwise (ADR 0002 #8: no daemon restart). A failed start
  leaves it stopped and the next reconcile retries. Reconciles are serialised.

### Request checks

In order; the first failure ends the request. Every response carries
`x-ravi-listener: 1` and `content-type: application/json`; refusals are
`{ "error": { "code", "requestId", "source": "ravi-listener" } }` with no
other field, no token and no claim value. Under Bun's node:http a header sent
more than once collapses to its last value; the checks below see that value.

1. `Host` equals `gateway.tunnel.hostname` (lowercased, no port) → else
   421 `host_mismatch`.
2. Method `POST`, raw target resolving to a command id under the
   §Identifiers grammar (`commandIdFromPath` on `req.url` as received: no
   `..`, `.`, `//`, `%`, uppercase, `_` segment, query or fragment), the id in
   the static allowlist `tasks.block|done|fail|report|show`, `X-Ravi-Gate: 1`
   present, and the route in the registry route table (`cliOnly` excluded)
   → else 404 `not_found`. There is no health route; any `GET` is 404.
   Then the tunnel gate (Console listener SPEC §Drift Check), read from
   ravi.db at most once per second: latched, no successful poll yet, or the
   last success older than 10 s → 503 `tunnel_drift` (outcome reason
   `drift_latched`, `no_successful_poll`, `poll_stale`). A read that throws
   refuses. It comes after steps 1 and 2 so those refusals stay unqueued; a
   Gate-shaped request refused here is marked and queued like any other.
3. Body at most 2 MiB by bytes received → else 413 `payload_too_large` with
   `Connection: close`, sent only after the oversized body was drained (at
   most 8 MiB past the limit, 10 s in all); a client that keeps sending past
   that bound, stalls or errors has its socket destroyed with no response and
   nothing queued.
4. `Cf-Access-Jwt-Assertion` verifies with `common_name` pinned to
   `accessClientId` → else 401 `access_invalid`; a key set that cannot be
   loaded is 503 `jwks_unavailable`.
5. `X-Ravi-Gate-Assertion` verifies against the configured issuer's gate
   JWKS, bound to method, raw target, body bytes, `X-Ravi-Request-Id`, the
   installation and the listener start time, single use. The run record is
   resolved only inside `resolveRun`, after the signature. No record → 401
   `grant_revoked`; any other failure → 401 `gate_assertion_invalid`; key set
   unavailable → 503.
6. A request carrying `X-Ravi-Sandbox-Grant`, even with an empty value → 400
   `body_invalid`. The run
   record is live (not revoked, not expired, grant present) → else 401
   `grant_revoked`. The stored grant re-verifies (`verifySandboxGrant`, own
   installation) → else 401 `grant_invalid` (503 when the key set is
   unavailable).
7. Run binding: the grant's run id, `jti`, `agent`, `task`, canonical `caps`
   and `cmds`, `org` and `inst` equal the record's, and the record's
   installation is this daemon's → else 401 `grant_revoked`.
8. The command is in the record's `cmds` and its scope is not `superadmin`
   → else 403 `command_not_allowed`.
9. Body: a JSON object (UTF-8, not an array) whose keys are all declared
   arguments or options of the command; `cwd` is never accepted; `taskId` is
   present → else 400 `body_invalid`. `taskId` is a string → else 400
   `argument_invalid`. `taskId` equals the record's home task → else 403
   `resource_forbidden`.
10. Limits: per-run token bucket 30/min, global 120/min, at most 2 in-flight
    requests per run and 8 overall → else 429 `rate_limited` with
    `Retry-After: 1`. Settings may lower these defaults, never raise them.
    An in-flight slot is held by the dispatch itself and released only when
    the dispatch settles, not when its 504 is answered.
11. The run's child context is live, of kind `sandbox-run`, bound to the
    record's agent and root → else 401 `grant_revoked`.
12. Dispatch through the SDK gateway `dispatch` with `source: "gateway"`, the
    child as `contextRecord`, `cwd` undefined, `allowSuperadmin` never set and
    the command's access forced to `requireConcreteResource: true`: group,
    wildcard and semantic capabilities never satisfy the check. A dispatch
    longer than 25 s is answered 504 `timeout` at 25 s; the dispatch keeps
    running and keeps its slots until it settles. A dispatcher usage error (400) is
    answered 400 `argument_invalid`; a dispatcher denial (403) is 403
    `resource_forbidden`; any other dispatcher response (the daemon's own
    contract envelope or the command's result) passes through with its
    status.
13. `request_count` and `last_request_at` are bumped on the record.

`Authorization` is never read. Logs and audits carry request id, run id,
command and outcome only; the audit event of a dispatched command carries the
child's `contextId`, its `parentContextId` (the root), the agent id, the
`runId` and the `requestId`, on the production audit path as well as in tests.

### Served-jti queue

- Before writing any response that carries a well-formed
  `X-Ravi-Request-Id`, the listener appends `{jti, runId, status, servedAt,
  assertionExp}` to `sandbox_served_jtis` through `executeWrite`
  (`assertionExp`: the verified Gate assertion's `exp`, null when none
  verified). Exception: a refusal at step 1 (`Host`) or step 2 (routing),
  which comes before any token is verified, is marked but never queued. If the append throws, the
  socket is destroyed with no response: never `res.destroy()`, which under
  Bun still flushes an empty 200.
- A request whose jti was already served keeps the first row (the refused
  replay is not a second entry).
- The queue holds at most 2048 unacknowledged jtis; beyond that the oldest
  are deleted and `jti_overflow_at` is recorded in `sandbox_listener_state`
  until 05b clears it after an acknowledged report that carried
  `jtiOverflow`.
- `assertion_exp` is a nullable column added by `reconcileColumns` to an
  existing `sandbox_served_jtis` table; older rows read back null.
- `dbListUnacknowledgedServedJtis(128)` returns oldest first;
  `acknowledgeServedJtis(jtis)` marks rows acknowledged and never deletes
  them; `dbPruneAcknowledgedServedJtis(before)` deletes only acknowledged
  rows.

### Run authority (`run-context.ts`)

- `createSandboxRunAuthority` refuses: a run id, jti, task, org or
  installation outside the §Identifiers grammar; an agent id that is not a
  sandbox agent id (`operator`, `root`, `system`, `*` included); an unknown
  agent; an agent holding `admin:system:*` (by `isAgentSuperadmin` or by its
  snapshot); `cmds` outside the static allowlist; an expired grant; a run id
  already recorded. A refusal leaves no live context behind.
- Root: `createRuntimeContext({ kind: "sandbox-run-root", agentId,
  capabilities: snapshotAgentCapabilities(agentId), expiresAt: grant exp })`.
- Child: `issueRuntimeContext` from root, kind `sandbox-run`, `cliName`
  `sandbox-run:<runId>`, capabilities = exactly the grant caps that parse as
  `read|mutate:task:<homeTaskId>` and that the root authorizes; every other
  grant cap is dropped and recorded in `metadata.droppedCaps` (and returned).
  Nothing is added. The child's `expiresAt` never exceeds the grant's.
- `revokeSandboxRun(runId, reason)` revokes the root with cascade (the child
  goes with it), sets `revoked_at`/`revoke_reason` and blanks `grant_jws`
  (the hash stays so a late assertion still resolves to `grant_revoked`).
  Idempotent; unknown run → null.
- `createSandboxRunAuthority` returns `root` and `child` without
  `contextKey`; no key leaves the function.
- The runs connection runs with `PRAGMA secure_delete = ON`, set once when
  the module's schema is ensured, so blanking `grant_jws` on revoke and every
  prune zero the bytes they free.
- Only the host CLI creates run authority. The listener reads it by context
  id, never by key, and never mints.

### Settings written by 05b

`gateway.listener.port`, `gateway.access.teamDomain`, `gateway.access.aud`,
`gateway.access.clientId`, `gateway.installationId`, `gateway.consoleUrl`,
`gateway.tunnel.hostname`. The drift latch is not among them (see
Vocabulary, Tunnel gate).

## Out Of Scope

- Writing the cloudflared config, running cloudflared and the `/config`
  drift poll (`sandbox/tunnel-runner`, 05a); clearing the latch on a rotate
  (05b).
- Sending the host report, acknowledging served jtis and clearing
  `jti_overflow_at` (05b).
- Creating run authority from a Console mint, attaching the E2B sandbox id
  and revoking on run end (06b, `ravi sandbox run`).
- Linux confinement of cloudflared and the macOS `sandbox-exec` spike.
