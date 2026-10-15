---
id: sandbox/grant-verify
title: "Sandbox Grant Verification"
kind: capability
domain: sandbox
capabilities:
  - grant-verify
tags:
  - sandbox
  - gateway
  - jwt
  - jwks
  - cloudflare-access
  - security
applies_to:
  - src/sandbox-listener/**
  - src/test/sandbox-grant-tokens.ts
owners:
  - rbbt-sandbox
status: active
normative: true
---

# Sandbox Grant Verification

## Intent

A connected sandbox run reaches the home daemon through the Console Gate
(`gw.ravi.bot`) and a Cloudflare tunnel. Before the daemon acts on any such
request, it verifies three tokens on its own, offline from policy: the
Cloudflare Access JWT (reachability), the Gate request assertion (this Gate
admitted this exact request) and the Console sandbox grant stored in the
local run record (what the run may do). `src/sandbox-listener/` is the pure
verification library for those three checks plus the JWKS cache they share.
It serves no HTTP; the listener (a later slice) composes it.

The daemon is one of exactly three grant verifiers (Gate, daemon, broker).
Its verdicts MUST equal the Console verifier's (`ravi-console`
`src/shared/sandbox/grant-verify.ts`) for every token, reason code included.
Parity rule: constants byte-equal, functions equivalent. The shared-constants
blocks of `contract.ts` are hashed by `contract-parity.test.ts` against the
value in `CHECKS.md`. The normative contract is Console's
`console/sandbox-gateway` spec family (`SPEC.md` §Identifiers, `grants`,
`gate`, `listener`); this spec is the OSS mirror. When they disagree,
Console's spec wins and this one is corrected.

## Vocabulary

- Grant: compact JWS `alg ES256`, `typ ravi-sandbox-grant+jwt`,
  `kid ^sandbox-grant-[a-z0-9][a-z0-9-]{0,62}$`, minted by Console, carried
  in the local run record, never forwarded by the Gate.
- Gate assertion: compact JWS `typ ravi-gate-assertion+jwt`,
  `kid ^sandbox-gate-…`, header `X-Ravi-Gate-Assertion`, one per forwarded
  request.
- Access JWT: `Cf-Access-Jwt-Assertion`, RS256, issued by
  `https://<accessTeamDomain>` for the Gate's service token.
- Configured Console issuer: the Console origin the host CLI logged in to
  (`gateway.consoleUrl`), passed explicitly to every verifier. The library
  has no default issuer. Never a value from any token.
- `key_set_unavailable`: the key set could not be loaded. Not a verdict on
  the token; the caller answers 503 `jwks_unavailable`, never 401.
- Misuse: a REQUIRED verifier input that is missing or malformed
  (`consoleIssuer`, `replayCache`, `listenerStartedAt`, `resolveRun`, a body
  that is not bytes) throws `TypeError` instead of returning a reason. A
  listener without replay protection or a run lookup does not serve.

## Invariants

### Grant (`verifySandboxGrant`)

- ES256 only; exact `typ`; `kid` matches the grant family grammar; any
  `crit` is refused; `jku`, `x5u`, `x5c` and `jwk` are ignored. Keys come only
  from `<consoleIssuer>/api/public/sandbox/jwks`.
- `iss` equals the configured Console issuer byte for byte; the issuer is a
  required input. `aud` is a single
  string `ravi-installation:<inst>`; `inst` equals it; both equal the daemon's
  own installation. `sub` is `sandbox-run:sbr_[a-z2-7]{26}`; `org` matches
  `^[A-Za-z0-9_-]{1,128}$`; `agent` matches `^[a-z0-9][a-z0-9_-]{0,63}$` and
  is never `operator`, `root`, `system` or `*`; `jti` is a lowercase UUID.
- `iat ≤ nbf ≤ exp`, `exp − iat ≤ 3900`, `nbf` and `exp` with 60 s skew,
  `iat` at most 60 s in the future.
- `cmds`: non-empty, at most 32, each 2–8 segments of `[a-z][a-z0-9-]{0,63}`,
  canonical (sorted, deduplicated) and a subset of the static allowlist
  `tasks.block`, `tasks.done`, `tasks.fail`, `tasks.report`, `tasks.show`.
  `tasks.comment` is not in the allowlist.
- `task` is required when any `cmds` entry is `tasks.*` and matches
  `^[A-Za-z0-9_-]{1,64}$`. `caps` is non-empty, canonical and holds only
  `read:task:<task>` and `mutate:task:<task>` for that exact `task`.
- `llm`, when present, is `{ models: string[1..32], budgetUsd: finite ≥ 0 }`.
- The result rebuilds the claims from validated fields only; unknown claims
  are dropped; no result ever contains the token or an error message.
- The reason codes and their order are those of the Console verifier.

### Gate assertion (`verifyGateAssertion`)

- ES256 only; `typ ravi-gate-assertion+jwt`; gate `kid` family; no `crit`;
  keys only from `<consoleIssuer>/api/public/sandbox/gate-jwks`. A grant kid
  or a grant key never verifies an assertion.
- Bound to the received request: method `POST`; the caller passes the RAW
  request target (`req.url` as received, no decoding, normalisation or query
  stripping) and `/api/v1/<seg…>` resolves to a command id under the
  §Identifiers grammar and equals `cmd`; `bodySha256` equals the base64url
  SHA-256 of the exact body bytes (`Uint8Array` only, never a string); `jti`
  is a UUID equal to `X-Ravi-Request-Id`.
- Bound to the run record through `resolveRun(runId)`: `sub` is
  `sandbox-run:<runId>` under the run id grammar; the record is resolved from
  that run id only after the signature verified and every stateless check
  passed, so an unverified `sub` never reaches storage. No record is
  `run_unknown` (listener: 401 `grant_revoked`, Console listener step 6); a
  record for another run is `subject_mismatch`; `grantSha256` equals the
  record's stored grant hash or the verdict is `grant_hash_mismatch`.
- `iss` is `https://gw.ravi.bot`; `aud` is the daemon's own installation.
- `exp − iat ≤ 60`, 60 s skew on `exp`; an `iat` earlier than the listener
  start time is refused with NO skew (Console listener SPEC step 5): an
  assertion served before a restart never verifies against the restarted,
  empty cache. A `jti` is single use and remembered until `exp + 60 s`. Only
  an accepted assertion is remembered.
- The replay cache and the start time are REQUIRED inputs; a verifier without
  them is a type error, never a silent pass. Exactly one cache per listener
  process: two caches accept the same `jti` once each. 04b backs the cache
  with the persisted served-jti queue so a restart inside `exp + 60 s` closes
  the window entirely.

### Access JWT (`verifyAccessAssertion`)

- RS256 only; `kid` required; no `crit`; keys only from
  `https://<accessTeamDomain>/cdn-cgi/access/certs`.
- `iss` is `https://<accessTeamDomain>` derived from the stored domain, which
  must match `^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$`; `aud`
  contains the stored AUD tag (64 hex); `type` is `app`; 60 s skew.
- `common_name` MUST equal the configured `accessClientId`
  (`serviceTokenClientId`), and the listener (04b) MUST refuse to start
  without it. The library keeps the parameter optional so it can be
  exercised without a pinned id; the MUST binds the listener.
- Note for Console spec: the Access JWT `kid` is REQUIRED (this verifier
  answers `kid_invalid` without it); Console listener SPEC step 4 does not
  state it.

### JWKS cache (`JwksCache`)

- https only. Each fetch: `GET`, `redirect: "error"`, 5 s timeout, at most
  64 KiB (declared and actual), a JSON document with a non-empty `keys` array
  whose every entry has a string `kid` and `kty` and public members only. A
  3xx, non-2xx, oversized, malformed, empty, `kid`/`kty`-less or
  private-bearing document is a failed fetch: the last good set is kept,
  nothing is persisted, and it counts as a failed refresh.
- The last good set is refreshed when older than 300 s. A failed refresh keeps
  serving the last good set for at most 3600 s after its fetch, with one
  retry per 30 s; past that the cache fails closed.
- An unknown `kid` triggers at most one refetch per 30 s; inside the cooldown
  the verdict is `key_unknown`; a refetch that fails is
  `key_set_unavailable`.
- A cold start with no set and a failing origin is `key_set_unavailable`.
- Optional persistence writes `{ fetchedAt, keys }` to a 0600 file after each
  successful fetch, through a temp file opened `O_CREAT | O_EXCL | O_NOFOLLOW`
  mode 0600 and renamed into place. On start the file is opened
  `O_RDONLY | O_NOFOLLOW` and checked through `fstat` on that descriptor:
  regular file, owned by the process uid, no group or world bits
  (`mode & 0o077 == 0`), size at most 64 KiB, then a past `fetchedAt` and a
  valid key set. A symlink, another uid's file or an oversized file is
  ignored before a byte is read. Its age is measured from `fetchedAt`, so a
  restart during a Console outage verifies only inside the stale window.

## Out Of Scope

The HTTP listener, run records, rate limits, body schema checks, dispatch,
host reports and tunnel drift belong to later slices and to Console's
`listener` spec. This library decides tokens; it never mints run authority.
