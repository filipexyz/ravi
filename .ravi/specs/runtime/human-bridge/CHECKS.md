# Checks

- `bun test src/bridge/` verifies signatures/nonce/replay, owner isolation,
  idempotency, stale versions, epoch revocation, approval ownership/digest,
  uncertain restart, private provider files and fail-closed guard validation.
- `bun test src/runtime/runtime-request-context.test.ts` verifies ordinary
  authorization and event delivery do not create or open bridge storage.
- `bun test src/runtime/runtime-request-context.test.ts` verifies existing
  authority paths and an ordinary agent named console; bridge sessions still
  require a valid delegation.
- `bun test src/runtime/codex-provider.test.ts` verifies ordinary Codex transport,
  provider configuration and its existing hook flag remain unchanged.
- `bun test src/approval/service.test.ts src/runtime/context-registry.test.ts`
  verifies ordinary approval policy, context liveness and delegated children.
- A separate private integration harness exercised real OIDC/browser, SSH,
  native runtime/model response, owner approval, durable reconnect, isolation,
  cancellation and live policy revocation. It passed 43 checks. Credentials,
  hostnames, deployment state and raw operational evidence are not published.
