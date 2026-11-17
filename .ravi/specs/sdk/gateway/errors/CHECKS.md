# Checks

Run each focused suite in its own process with an isolated state directory and the SQLite production-path guard. The hook fixture owns and removes its temporary gateway state, so it must not share cached database handles with another suite:

```bash
for test_file in \
  src/sdk/gateway/error-contract.test.ts \
  src/sdk/gateway/permissions-errors.test.ts \
  src/sdk/gateway/auth-expiration.test.ts \
  src/sdk/gateway/dispatcher.test.ts \
  src/sdk/gateway/server.test.ts \
  src/sdk/gateway/server-log.test.ts \
  src/cli/remote-gateway.test.ts \
  src/cli/transport-contract.test.ts \
  src/cli/commands/context-hook-gateway.test.ts \
  src/cli/commands/context-hook-alias.test.ts
do
  bun test --preload ./src/test/isolated-runtime-preload.ts "$test_file" || exit
done
```

- Real tasks/create missing instructions: 422, VALIDATION_ERROR, field/argument/issues, exit 2, non-retryable.
- Expected failure: public message and next action survive HTTP to CLI.
- Issue-less canonical usage errors retain uncatalogued reasons at HTTP 400 and 422; secret assignments and credential-directory path suffixes are redacted without erasing the reason, safe paths or request id. Existing unsafe dump/context-key negatives and issue-first projection remain covered.
- Real `permissions allow` dry-runs through the gateway and CLI with `--agent` cover an unknown profile, an invalid contact and a missing current chat. JSON/text output retain the daemon message, code and request id; no grants are applied. A valid canonical contact plus executor still resolves successfully.
- Internal failure: safe 500 and correlated stack/cause log; no body/secret leakage.
- Pre-dispatch auth failure: same safe boundary.
- Real registry credentials on open and protected routes: expiry returns `CONTEXT_EXPIRED`/401 before the handler and survives the HTTP-to-CLI projection; a valid credential without grants returns `PERMISSION_DENIED`/403.
- Revoked, malformed, unknown and invalid-bridge credentials are rejected on open routes; revocation wins over expiry, keys stay private and omitted credentials preserve the command's existing policy.
- Real hook subprocess through the host socket: expired/revoked/unknown credentials produce `deny` with 401, the correct context code and cause, no fabricated missing capability, no key leakage and no retry encouragement. Live denied/ungranted credentials retain the exact `read:context:codex-bash-hook` capability, `PERMISSION_DENIED` and HTTP 403. These cases MUST remain in the focused gateway regression slice.
- 400/401/404/405/413 and concurrent requests: canonical envelopes and unique ids.
- Repeated failure: one diagnostic per signature/window, count after window, reference to first diagnostic.
- TypeScript SDK error projection: ids and validation fields survive; malformed metadata is dropped.
