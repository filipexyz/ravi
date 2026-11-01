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

- Denied lease renewals (send revoked or agent removed) persist the new policy
  revision, immediately remove action authority, reject stale grants and cancel
  native work on the next dispatcher tick (`src/bridge/service.test.ts`).
- Ordinary wildcard/admin/self capabilities cannot reach private sessions; CLI
  read/recap/trace/list and runtime controls exclude them, including aliases.
  Shared chat history never receives bridge messages (`src/permissions/scope.test.ts`,
  `src/cli/commands/sessions.test.ts`, `src/db.test.ts`).
- Request-context and provider-bootstrap tests reject Pi/Claude/Grok for bridge
  before preparation; ordinary provider contract tests remain unchanged.

- The service behavioral suite now enters via the canonical HTTP dispatcher;
  `src/sdk/gateway/console.test.ts` checks the new signed request boundary.

- Desktop delivery tests exercise record-only without execution, after-reply FIFO, after-tool release, pending cancellation, receipt dedupe, revocation and restart lease expiry in `src/bridge/service.test.ts`.
- Bridge turn envelopes remain separate in the delivery queue, including when adjacent inputs belong to one human.

- Team creation rejects unsigned/unavailable candidates; an invited synthetic
  member sees only the new team, never the creator's private history.
- Member renewal cannot extend another requester's turn; @everyone is sequential.
- Handoff is deduplicated, roster-bound and waits for parent completion.
- Desktop resource tests reject read-to-write escalation, other agents' loops,
  invalid shell owners and conversation reads by a foreign subject.
- Run the bridge suite with isolated-runtime-preload, never a live state directory.
