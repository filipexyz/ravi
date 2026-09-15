# Model-broker runtime contract

The OSS runtime may persist a public broker selection on an agent:
`{ brokerId, profileRef, required? }`. When the global requirement is enabled
without a selection, Ravi follows the authenticated Hub default through the
virtual `{ brokerId: "hub", profileRef: "canonical" }` selection. A registered
`ModelBroker` resolves that selection for every turn into a short-lived,
secretless route lease. The lease,
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
wire. The root supervisor gives the core process one PID-bound capability on an
inherited descriptor and exposes `/run/ravi/identityd-runtime.sock` only to the
runtime group. The core reads and closes the descriptor before provider startup;
identityd independently verifies the bearer, peer UID, and exact supervised PID.
The root-only admin socket remains separate. The adapter validates the Hub
authority response and converts the private grant and signing-forwarder handle
into the generic lease. Hub connection identifiers and upstream providers never
enter the generic core or provider environment.

Provider clients receive materialized, private configuration containing only the
loopback route and public headers. Provider API keys, bearer tokens, cookies,
daemon credentials, and identityd capability metadata are stripped. Claude
declares `one-shot-capability`: each query snapshots the per-turn binding and its
mandatory Linux sandbox denies tools access to Unix sockets and loopback. Codex
and Pi remain `principalIsolation: none`, so broker-required traffic selecting
either adapter fails closed until an equivalent OS boundary is attested.

`runtime.model_broker.required=true` enables the persisted global fail-closed
requirement. A supervised deployment may enforce the same requirement with
`RAVI_MODEL_BROKER_REQUIRED=true`; the host policy is additive and cannot be
disabled by an agent or database value. Invalid policy values fail closed. The
policy variable and identityd capability metadata are removed from provider and
tool environments. Per-agent `defaults.modelBroker.required=true` enables the
broker for one agent. A selection with `required:false` remains a draft and does
not change runtime traffic. Use `ravi agents model-broker` to inspect or edit the
public broker selection.
