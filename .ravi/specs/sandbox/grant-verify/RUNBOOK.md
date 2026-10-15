# Sandbox Grant Verification / RUNBOOK

## Before Editing

1. Read this spec and the Console contract it mirrors:

```bash
./bin/ravi specs get sandbox/grant-verify --mode full
```

Console side (read-only, the parity reference): `ravi-console`
`src/shared/sandbox/contract.ts`, `grant-verify.ts`, their tests, and
`.ravi/specs/console/sandbox-gateway/{grants,gate,listener}/SPEC.md`.

2. Change the Console spec first when a rule changes. Then update
   `src/sandbox-listener/contract.ts` so every constant stays byte-equal
   (functions equivalent), port the new Console test case into
   `grant.test.ts`, and update this spec and `CHECKS.md` in the same pull
   request.
3. Bump the parity hash in lockstep. Any edit inside a
   `// shared-constants:begin` … `end` block of `contract.ts` fails
   `contract-parity.test.ts` until the `shared-constants sha256` line in
   `CHECKS.md` is updated; compute it the way the test does (sha256 over the
   blocks' contents joined by `\n`, marker lines excluded) and record the new
   value in the same commit as the Console change it mirrors. Never bump it
   to make a test pass without a Console-side change to point at.

## Changing The Verifier

- Keep the check order and the reason codes identical to Console's
  `grant-verify.ts`. A new reason code on one side without the other is a
  contract break.
- Never read a key from a token (`jwk`, `jku`, `x5u`, `x5c`) and never derive
  the issuer or a JWKS URL from a token claim.
- Every rejection path must stay free of the token and of error text.
- Required inputs stay required. `consoleIssuer`, `replayCache`,
  `listenerStartedAt` and `resolveRun` have no defaults and throw on misuse;
  do not add a fallback "for tests", build the option in the test instead.
- The listener (04b) owns exactly one `GateAssertionReplayCache`, passes the
  raw request target and the body bytes, resolves the run record only inside
  `resolveRun`, configures `accessClientId` and refuses to start without it.

## Diagnosing Refusals

| Reason | Meaning | First step |
| --- | --- | --- |
| `key_set_unavailable` | JWKS could not be loaded (cold start, stale window over, failed unknown-kid refetch) | Check the Console origin's `/api/public/sandbox/jwks` (or `gate-jwks`, or the Access certs URL) and the persisted cache file's mode and `fetchedAt` |
| `key_unknown` | `kid` not in the published set after at most one refetch per 30 s | Confirm the key was published as `retired` at least 300 s before use |
| `audience_mismatch` | Grant or assertion for another installation | Compare `gateway.installationId` with the Console login; a re-login can change it |
| `issuer_mismatch` | `iss` differs from the configured Console origin | Check `gateway.consoleUrl`; the issuer is never taken from the token |
| `jti_replayed` | Same Gate assertion presented twice | Expected on a retry; the Gate mints a new request id per attempt |
| `issued_before_start` | Assertion minted before this listener process started | Expected for seconds after a restart; a Gate retry carries a fresh `iat`. Persistent: compare the daemon clock with the Gate's |
| `run_unknown` | Verified `sub` names no local run record (listener answers 401 `grant_revoked`) | The run ended or was never created on this host; check the run table |
| `grant_hash_mismatch` | Assertion for a different grant than the stored one | The run record is stale or the Gate forwarded another run's request |
| `common_name_mismatch` | Access service token differs from the pinned client id | Console rotated the Gate's service token; refresh `gateway.access.clientId` |

## JWKS Outage

The daemon keeps verifying for 3600 s after the last successful fetch, and a
restart inside that window still verifies when a persisted cache file exists.
A Console publication that returns `{ "keys": [] }` or keys without `kid` is
treated as an outage: the last good set stays in use and nothing is persisted.
A persisted file that is a symlink, owned by another user, group/world
readable or over 64 KiB is ignored; delete it and let the next fetch rewrite
it.
Past the window every request fails with 503 `jwks_unavailable` until the
origin answers again. Do not extend the window by editing `fetchedAt`; wait or
fix the origin.

## Rotation

A new grant or gate key must appear in the published JWKS at least 300 s
before it signs anything. Verifiers refetch an unknown `kid` at most once per
30 s, so a key published late causes `key_unknown` for up to 30 s per daemon.
