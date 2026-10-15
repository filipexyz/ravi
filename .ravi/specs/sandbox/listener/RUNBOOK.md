# Sandbox Listener / RUNBOOK

## Before Editing

1. Read this spec, `sandbox/grant-verify` and the Console contract:

```bash
./bin/ravi specs get sandbox/listener --mode full
./bin/ravi specs get sandbox/grant-verify --mode rules
```

Console side (read-only): `ravi-console`
`.ravi/specs/console/sandbox-gateway/listener/SPEC.md` (§Request Checks,
§Authorization And Dispatch, §Responses), `gate/SPEC.md` §Gate Request
Assertion and §Upstream Classification, `tunnels/SPEC.md` §Host Report.

2. Change the Console spec first when a check, a code or the order changes;
   then this spec, `server.ts` and `server.test.ts` in the same pull request.
3. Keep the check order. A refusal code that the Console table does not list
   is a contract break; the Gate passes the listener's envelope through to
   the sandbox CLI only when it is JSON with the marker.
4. Never read `Authorization`, never log a header value, never put a token
   or a claim value in a response or a log line.
5. The allowlist is `SANDBOX_COMMAND_ALLOWLIST` in `contract.ts` and is
   hashed by `contract-parity.test.ts`; adding a command starts in Console
   (`sandbox/grant-verify` RUNBOOK).

## Operating

- The daemon starts the listener when `gateway.listener.port` and the other
  `gateway.*` settings are present; `ravi gateway expose` (05b) writes them.
  A log line `Sandbox listener settings are invalid` names the malformed
  keys; fix the setting: the daemon picks it up on `ravi.config.changed` (or
  within 30 s) and starts, restarts or stops the listener without a restart.
- `Sandbox runs pruned at start` (every daemon start, listener or not) logs
  how many stale runs and acknowledged jtis went. `Sandbox listener ready`
  logs the port, the tunnel hostname and how many served jtis were preloaded
  into the replay cache.
- The listener never binds anything but `127.0.0.1`. Reachability comes from
  cloudflared's ingress to `http://127.0.0.1:<port>` (05a).

## Diagnosing Refusals

Every refusal logs `requestId`, `runId` (once known), `cmd`, `status`,
`code` and the verifier `reason`. The client sees only the code.

| Code | Meaning | First step |
| --- | --- | --- |
| 503 `tunnel_drift` | Reason `drift_latched`: the runner latched drift. `no_successful_poll`: the runner has not polled yet (or stopped). `poll_stale`: no successful poll for 10 s (runner dead or hung) | `pm2 logs ravi-gateway`; `sandbox/tunnel-runner` RUNBOOK. Only a successful rotate clears a latch (05b) |
| 421 `host_mismatch` | `Host` differs from `gateway.tunnel.hostname` | Compare the cloudflared ingress hostname with the setting |
| 404 `not_found` | Not a `POST` on an allowlisted route, or no `X-Ravi-Gate: 1` | Expected for probes; a legitimate Gate request means an allowlist drift between Console and `contract.ts` |
| 401 `access_invalid` (`common_name_mismatch`) | Access service token differs from the pin | Console rotated the Gate's token; refresh `gateway.access.clientId` |
| 401 `gate_assertion_invalid` (`jti_replayed`) | Same assertion twice | Expected on a Gate retry; persistent means a replaying party upstream |
| 401 `gate_assertion_invalid` (`issued_before_start`) | Assertion older than this listener process | Expected for seconds after a restart; persistent means clock skew |
| 401 `grant_revoked` (`run_unknown`, `run_inactive`, `run_binding_mismatch`, `context_inactive`) | No live run record or authority for the verified run | The run ended, was revoked or never existed on this host: `sandbox_runs` and `ravi context lineage <root>` |
| 401 `grant_invalid` | The stored grant no longer verifies | Grant expired or the installation changed (re-login); the run must be minted again |
| 403 `command_not_allowed` | Static command outside the run's `cmds` | Mint the run with that command, or stop calling it |
| 403 `resource_forbidden` | `taskId` is not the home task, or the child lacks the concrete cap | Check `droppedCaps` in the child's metadata; grant the agent the cap locally and mint again |
| 400 `body_invalid` / `argument_invalid` | Unknown or `cwd` key, missing or mistyped `taskId`, bad JSON | Send only the command's declared fields |
| 429 `rate_limited` | 30/min per run, 120/min overall, 2 and 8 in flight | Back off; the Gate's own limits are the ceiling |
| 503 `jwks_unavailable` | A key set could not be loaded | `sandbox/grant-verify` RUNBOOK §JWKS Outage |
| 504 `timeout` | Dispatch exceeded 25 s | The command itself is slow; look at the task and the daemon log |

A connection closed with no response at all means the served-jti append
failed (disk full, database locked beyond the write retry): the daemon log
has `Served-jti append failed; closing without a response`.

## Served-jti Queue

- `SELECT COUNT(*) FROM sandbox_served_jtis WHERE acknowledged_at IS NULL`
  grows while Console is unreachable and shrinks as 05b's reports are
  acknowledged. Above 2048 the oldest are dropped and
  `sandbox_listener_state.jti_overflow_at` is set; 05b reports `jtiOverflow`
  until Console acknowledges a report that carried it, then clears the key.
- Never delete unacknowledged rows by hand: Console will treat the served
  requests they name as unreported and mark the gateway `unexpected`.
- Acknowledged rows older than 10 minutes are pruned at every daemon start
  and every 10 minutes while the listener runs.
- A 421 `host_mismatch` or a 404 `not_found` is answered with the marker but
  never queued: those refusals come before any token is verified.

## Run Records

- `sandbox_runs` holds one row per run created by the host CLI. Revoking
  (`revokeSandboxRun`) blanks the grant and revokes both contexts; expired
  and revoked rows are deleted at daemon start.
- To revoke a run by hand before 06b ships its command: from a REPL on the
  host, `revokeSandboxRun("<runId>", "operator_revoked")` from
  `src/sandbox/run-context.ts`. Console's own revoke still has to happen so
  the Gate stops admitting the grant.
