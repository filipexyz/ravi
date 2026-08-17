# Model-broker runtime contract

The OSS runtime persists only a public broker selection on each agent:
`{ brokerId, profileRef, required? }`. A registered `ModelBroker` resolves that
selection for every turn into a short-lived, secretless route lease. The lease,
not the agent's provider or model defaults, is authoritative for the executable
runtime provider and model.

The generic lease contains only runtime attribution, route and compatibility
revisions, expiry, and a loopback HTTP transport. The transport is restricted to
`http://127.0.0.1`, an absolute request path, an allowlisted model protocol, and
public routing headers. Authorization, cookie, host, and proxy headers are
rejected. Ravi never persists the lease, transport, or headers.

Route planning happens before provider instantiation. A live session restarts
before delivering the turn when the broker changes the executable provider,
model, route revision, or compatibility revision. The launcher atomically
claims the exact in-memory lease selected by the dispatcher and hands it to the
request builder without a second grant. Cache misses replay the same stable turn
identity so a broker can return its idempotent decision.

Every provider attempt reports one terminal outcome. Credential failover may
advance only before any input mutation, tool start, or output materialization.
Abandoned attempts are reported with `effectState: none` before a provider starts.
Contradictory broker feedback fails closed.

The built-in `hub` adapter is the only OSS module that knows the Hub `identityd`
wire. It uses a root-controlled Unix socket, validates the Hub authority response,
and converts the private grant and signing-forwarder handle into the generic lease.
Hub connection identifiers and upstream providers never enter the generic core.

The Hub adapter is intentionally unavailable to the production daemon in this
phase. The daemon and its tools share the unprivileged `ravi` UID, while
`/run/ravi/identityd.sock` remains `root:root` mode `0600`; there is no supported
pathname, environment token, group-readable socket, or loopback admin endpoint.
Changing those permissions would let same-UID tools mint route authority. A future
activation requires a root supervisor to deliver an anonymous, capability-bearing
Unix channel only to the core process, with close-on-exec/non-inheritance and a
non-dumpable process boundary. Until that lifecycle exists and is tested end to
end, Hub route resolution fails closed.

Provider clients receive materialized, private configuration containing only the
loopback route and public headers. Provider API keys, bearer tokens, cookies, and
daemon credentials are stripped. Built-in Codex, Claude, and Pi currently declare
`principalIsolation: none`, so a required broker selection cannot activate until
the adapter has verified principal isolation.

`runtime.model_broker.required=true` enables the global fail-closed requirement.
Per-agent `defaults.modelBroker.required=true` enables it for one agent. A selection
with `required:false` remains a draft and does not change runtime traffic. Use
`ravi agents model-broker` to inspect or edit the public broker selection.
