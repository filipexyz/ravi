# Home Passthrough / WHY

## Rationale

### A per-invocation target, not `RAVI_GATEWAY_URL`

`RAVI_GATEWAY_URL` retargets every decorated command and sends the runtime
context-key as a bearer. Inside a sandbox the worker's own `tasks report` must
keep going to the sandbox's local daemon, and the sandbox's `rctx_` key must
never reach HOME. A flag set by the entrypoint for one invocation keeps both
transports apart, and since it is not env, nothing the worker spawns inherits
it.

### The grant is the only credential

HOME authorizes a sandbox request from the grant and its local run record
(ADR 0001, Console listener spec), never from a context key or the operator.
Sending anything else (a bearer, the cwd, the internal socket marker, the
sandbox's agent or session ids) would either be ignored or, worse, be
something a future change might trust. The Gate drops every client header but
`content-type` and `accept` anyway; the CLI not sending them keeps them out of
the egress proxy's and the Gate's view too.

### Env fallback, validated and never echoed

E2B header injection keeps the grant out of the sandbox entirely; the env
fallback exists for runs where that is not available (ADR 0003 #9, explicit
OSS flag in 06b). A value in env is readable by the worker, so it is at least
never printed: a malformed value is refused without echo, and errors are built
from validated fields only (code pattern, UUID request id).

### `https:` only

Every request carries the task's data and possibly the grant. Unlike
`RAVI_GATEWAY_URL`, HOME is never on this machine, so there is no loopback
exception. Credentials, a query or a fragment in the URL have no use with the
Gate and could leak through logs, so they are refused rather than stripped.

### Client-side allowlist that only narrows

The Gate and the listener enforce `cmds ∩ allowlist`; the CLI check exists to
fail fast with exit 3 instead of a round trip and a 403. `RAVI_HOME_COMMANDS`
mirrors the grant's `cmds`, so it may narrow the static list but never widen
it. `tasks.comment` stays out until OSS declares its task as `resourceId` and
Gate comments cannot steer a live session (ADR 0003 #3).

### Error codes with the request id

An operator debugging a refused sandbox request joins three logs (Gate audit,
listener log, Ravi audit) on the request id; printing it is the cheapest way to
make that possible. Exit codes follow the CLI contract: bad input 2, a command
outside the grant 3 (same as the client-side refusal), everything else 1.
