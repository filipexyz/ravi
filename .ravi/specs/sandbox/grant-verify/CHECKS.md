# Sandbox Grant Verification / CHECKS

## Suites

```bash
bun test src/sandbox-listener/
bun run typecheck
bunx biome check src/sandbox-listener/ src/test/sandbox-grant-tokens.ts
```

No check reaches the network: every key is generated at runtime by
`src/test/sandbox-grant-tokens.ts` and every JWKS fetch is a fake.

## Parity Guard

`contract-parity.test.ts` hashes the concatenation of every
`// shared-constants:begin` … `// shared-constants:end` block of
`src/sandbox-listener/contract.ts` and compares it to this value. Change it
only in the same pull request as a Console `contract.ts` change (RUNBOOK
§Before Editing).

- shared-constants sha256: `dbd5105af8df63d50c1c04e18d47594d717a2ec8b0db9fc182521c9e283ca4a1`

## Checks

- `verifySandboxGrant` MUST accept a well-formed grant for its own installation
  and rebuild the claims from validated fields only, dropping unknown claims
  (`grant.test.ts`, "accepts a well-formed grant").
- It MUST reject, with the Console reason code: wrong `aud` (`audience_invalid`
  or `audience_mismatch`), `inst` (`inst_mismatch`), `iss` (`issuer_mismatch`),
  `typ` (`typ_mismatch`), `kid` outside the grant family (`kid_invalid`),
  `alg: none` and HS256 with public key bytes and ES384 (`alg_not_allowed`),
  any `crit` (`crit_not_allowed`), expired (`expired`), future `nbf`
  (`not_yet_valid`), `exp − iat` of 3901 s (`lifetime_exceeded`),
  non-canonical `cmds` (`cmds_not_canonical`), `tasks.comment`
  (`cmds_not_allowlisted`), caps for another task (`caps_task_mismatch`),
  reserved agent names (`agent_invalid`) and a valid grant for another
  installation (`audience_mismatch`).
- `jku`, `x5u`, `x5c` and `jwk` headers MUST never supply the key: an attacker
  key fails with `signature_invalid`; on a genuine token they are ignored.
- A key set that throws anything but a jose verdict MUST yield
  `key_set_unavailable`; an unknown `kid` yields `key_unknown`; no result
  contains the token or the error text.
- `verifySandboxGrant` MUST throw `TypeError` without a `consoleIssuer`; a
  token without `iss` never passes against a missing issuer
  (`grant.test.ts`).
- `verifyGateAssertion` MUST reject a non-`POST` method
  (`request_method_invalid`), a raw target outside the command grammar or
  carrying a query (`request_path_invalid`), a target for another command
  (`cmd_mismatch`), a body whose hash differs (`body_hash_mismatch`), a `jti`
  that differs from `X-Ravi-Request-Id` (`jti_mismatch`), a reused `jti`
  within `exp + 60 s` (`jti_replayed`), a `sub` outside the run grammar or a
  record for another run (`subject_mismatch`), a `sub` with no record
  (`run_unknown`), another grant's hash (`grant_hash_mismatch`),
  `exp − iat > 60` (`lifetime_exceeded`), an `iat` before the listener start
  with no skew (`issued_before_start`) and a grant-family `kid` or grant key
  (`kid_invalid`, `signature_invalid`) (`gate-assertion.test.ts`).
- `verifyGateAssertion` MUST throw `TypeError` without `replayCache`,
  `listenerStartedAt` or `resolveRun`, or with a string body.
- `resolveRun` MUST be invoked only after `jwtVerify` and every stateless
  check passed, once, with the verified run id: never for a token signed by
  another key, for another installation, expired, pre-start, replayed or
  with a malformed `sub` ("an unverified or stale assertion never reaches
  storage").
- Restart scenario: an assertion with `iat = T` served at T, then presented
  at T+119 to a listener started at T+59 with an empty cache, MUST be
  `issued_before_start`. Two caches accept the same `jti` once each; the
  test documents it as closed by 04b's persisted served-jti queue.
- `commandIdFromPath` MUST return null for `_`-prefixed, empty, encoded,
  uppercase or more than 8 segments and for any query string.
- `verifyAccessAssertion` MUST reject a wrong `aud` (`audience_mismatch`), a
  wrong or token-supplied `iss` (`issuer_mismatch`), another team's key
  (`signature_invalid`), a `common_name` other than the pinned client id
  (`common_name_mismatch`), `type` other than `app` (`type_invalid`), ES256
  (`alg_not_allowed`) and a team domain outside `*.cloudflareaccess.com`
  (`config_invalid`) (`access-jwt.test.ts`).
- `JwksCache` MUST fail closed on a cold start with the origin down; serve a
  stale set while the origin fails for at most 3600 s after its fetch with one
  retry per 30 s; refetch an unknown `kid` at most once per 30 s; refuse a
  body over 64 KiB, a redirect, a non-2xx, a malformed document, an empty
  `keys` array, an entry without `kid` or `kty`, and private key members;
  send `redirect: "error"` with an abort signal (`jwks-cache.test.ts`).
- A good set followed by `{ "keys": [] }` MUST keep verifying tokens inside
  the stale window, count as a failed refresh (one retry per 30 s, window
  still ends 3600 s after the good fetch) and never persist the empty set.
- The persisted cache MUST be written mode 0600 with `fetchedAt`; a restart
  with the origin down verifies inside the stale window; a file older than
  3600 s, with a future or missing `fetchedAt`, with mode other than 0600,
  with no keys or a key without `kid`, or with private members is treated as
  a cold start.
- A symlink to a 0600 file MUST be ignored for reading and for writing (the
  target is untouched, no temp file is left); a file over 64 KiB MUST be
  ignored by its `fstat` size before it is read (the same file loads under a
  larger `maxBytes`).
- `parseCapabilityString` MUST return null, never throw, on malformed input
  and keep colons inside the object id (`capability-string.test.ts`).
- `bun run test` MUST include `bun test src/sandbox-listener/`
  (`package.json`).
- `jose` MUST be a declared dependency (`package.json`), so every verifier
  and the cache share one module instance for `instanceof` error mapping.
- Parity run (manual, before a release): the Console suite
  `grant-verify.test.ts` executed against `verifySandboxGrant` through a
  Console-shaped adapter passes case for case (last run 2026-10-13, after the
  04a follow-ups: see the pull request).
