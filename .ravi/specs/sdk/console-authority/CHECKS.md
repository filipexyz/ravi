# Checks

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/sdk/gateway/console.test.ts`
  verifies HTTP binding, JTI reuse, local-token rejection, private ownership,
  browser-independent origins, policy revocation, receipts, SSE and existing controls.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/bridge/service.test.ts`
  runs the private-session behavioral suite through the actual canonical dispatcher:
  approvals, cancellation, concurrent admission, recovery, cursor scope and leases.
- `bun test src/permissions/scope.test.ts src/cli/commands/sessions.test.ts`
  verifies that ordinary/admin CLI contexts still cannot read private sessions.
- Build, quality, TypeScript/Dart/Swift generation and drift checks must pass on
  the proposed commits. Historical bridge results are not validation of this code.
- The paired Fleet test runs the real Ravi HTTP listener and SQLite journal through
  Node HTTP/SSE and restricted SSH. Its runtime is a fixture, not a model E2E proof.
