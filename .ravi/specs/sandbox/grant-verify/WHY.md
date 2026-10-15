# Sandbox Grant Verification / WHY

## Rationale

### A parity copy of the Console verifier, not a shared package

Console's `grant-verify.ts` runs in Workers and must stay `node:`-free; the
daemon bundles its own code and is published to npm from another repository.
A shared package would couple two release trains for 200 lines. Instead the
daemon keeps a copy of the contract (`contract.ts`) under one rule, constants
byte-equal and functions equivalent, plus a check-for-check port of the
verifier (`grant.ts`), and its test suite is a port of Console's: any
divergence shows up as a differing reason code. The shared-constants blocks
are hashed against `CHECKS.md` so a constant cannot drift without a visible
spec change; `jose` is a declared dependency so a single module instance
backs the `instanceof` error mapping.

### `key_set_unavailable` is not a 401

A JWKS outage says nothing about the token. Answering 401 would teach the
sandbox worker that its grant is bad and end the run; answering 503 lets the
Gate retry. The cache therefore throws a non-jose error, and the verifiers map
every non-jose error to `key_set_unavailable` exactly as Console does.

### Why a Gate assertion at all (ADR 0005)

One Access application covers every tunnel host, so an Access JWT could be
replayed from one installation's tunnel to another's. The Gate signs each
forwarded request with claims bound to the installation, the run, the
command, the body and the request id. The daemon checks all of them, plus the
hash of the grant it already holds, so an impostor origin that learns request
bodies still learns no grant (ADR 0009, 0012).

### Request binding inside the verifier

The assertion carries `cmd`, not a method or path. The verifier still takes
the raw method and the raw request target: refusing anything but `POST` and
deriving `cmd` from the target with the §Identifiers grammar keeps path
normalisation (`_stream`, `..`, `%2e`, `//`, uppercase, queries) in one
audited place instead of in the listener. The body is bytes only: a string
would be re-encoded by the hash and could differ from what was received.

### The run record is looked up after the signature, never from `sub`

The assertion's `sub` names the run record whose stored grant hash the
verifier compares. Looking it up before `jwtVerify` would let any
unauthenticated request drive a storage read with an attacker-chosen id, so
the verifier takes a `resolveRun` callback and calls it exactly once, after
the signature, audience, request binding, freshness and replay checks have
all passed. Storage sees only run ids the Gate actually signed.

### Replay protection cannot be switched off

A verifier that treats the replay cache as optional will, somewhere, be
constructed without one and pass every replay silently. The cache and the
listener start time are therefore required inputs, and the `iat ≥ start`
rule has no skew: with a 60 s allowance an assertion served at T, a restart
at T+59 and a replay at T+119 would verify against the empty cache inside
the `exp + 60 s` window (the reviewer's scenario). Two caches in one process
still accept the same `jti` once each, which is why the listener owns
exactly one and 04b persists the served-jti queue.

### Persisted JWKS, 0600, honouring `fetchedAt`

A daemon restart during a Console outage would otherwise be a cold start and
refuse every request for the outage's duration. Persisting the public keys is
safe only if the file cannot be swapped by another local user: it is opened
`O_NOFOLLOW` and every check (regular, same uid, no group or world bits,
size) runs on the opened descriptor through `fstat`, so a symlink or a
path swapped between check and read cannot win, and the age counts from the
original fetch, so the stale window is never extended by restarting. An
empty published set is treated as an outage rather than a rotation to
nothing: replacing or persisting it would turn a Console publication bug
into `key_unknown` 401s that end every run.

### Plan items the Console spec superseded

The stack plan's `sub` regex (`sbr_[A-Za-z0-9_-]+`), 65-minute phrasing and
looser `cmds` grammar were written before Console fixed the contract. The
Console constants (`sbr_[a-z2-7]{26}`, 3900 s, 2–8 segments) are used instead.
