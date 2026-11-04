# Checks

Run focused tests with an isolated state directory and the SQLite production-path guard:

```bash
RAVI_STATE_DIR=/tmp/ravi-error-contract-state bun test --preload ./src/test/isolated-runtime-preload.ts src/sdk/gateway/error-contract.test.ts src/sdk/gateway/auth-expiration.test.ts src/sdk/gateway/dispatcher.test.ts src/sdk/gateway/server.test.ts src/sdk/gateway/server-log.test.ts src/cli/remote-gateway.test.ts src/cli/transport-contract.test.ts
```

- Real tasks/create missing instructions: 422, VALIDATION_ERROR, field/argument/issues, exit 2, non-retryable.
- Expected failure: public message and next action survive HTTP to CLI.
- Internal failure: safe 500 and correlated stack/cause log; no body/secret leakage.
- Pre-dispatch auth failure: same safe boundary.
- Real registry credentials on open and protected routes: expiry returns `CONTEXT_EXPIRED`/401 before the handler and survives the HTTP-to-CLI projection; a valid credential without grants returns `PERMISSION_DENIED`/403.
- Revoked, malformed, unknown and invalid-bridge credentials are rejected on open routes; revocation wins over expiry, keys stay private and omitted credentials preserve the command's existing policy.
- 400/401/404/405/413 and concurrent requests: canonical envelopes and unique ids.
- Repeated failure: one diagnostic per signature/window, count after window, reference to first diagnostic.
- TypeScript SDK error projection: ids and validation fields survive; malformed metadata is dropped.
