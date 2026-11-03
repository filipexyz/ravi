# Managed-session SSE authorization — additive local handoff

Combined follow-up on e501e5d is now documented in
[STREAM-INTEGRATION.md](STREAM-INTEGRATION.md). The local evidence below remains
the original source-commit evidence, not the subsequent Next/SSO proof.

Parent42991d54. No migration, deployment, push, new runtime, provider call or UI
activation. This is one closure from the enforcement inventory, not the proposed
conversational bridge or a guarantee about every background job/stream.

## Server contract

`createManagedRuntimeStreamSource` in
`src/server/console/managed-runtime-stream-source.ts` accepts the server-only
`resolveWorkspace(): Promise<ConsoleWorkspace | null>` callback and the requested
project/instance/session. It resolves current identity and nested scope once to
pin the human/org/mode and canonical project UUID. Its `loadEvents(afterSequence)`
resolves identity again before querying/decrypting, and `authorizeEmission()`
resolves it again and checks the current policy/nested scope without reading
content or creating a runtime session. The callback MUST NOT return a captured
workspace or trust body/headers for identity. This is a browser source; an attached
CLI delegation is rejected, not flattened into a human-only decision.

`assertManagedRaviSessionReadAccess` in managed-runtime-commands.ts shares the same
read-only project/instance/session resolver as listManagedRaviSessionEvents.
No enqueue/claim/report, primary-session creation, or grant mutation is performed.

`createManagedRuntimeEventStream` now requires `authorizeEmission`. It awaits it
after loading and before initial/next batches and heartbeats. Errors discard the
pending data and emit only the existing generic stream-unavailable event. Abort
and reader cancellation discard unresolved load/authorization results and clean
their listeners/timers. Closing a stream does not abort an in-flight DB query or
recall previously queued bytes. A revocation after the final check can still race
that batch: no instantaneous or atomic network-revocation claim.

The sole route caller is:
`src/app/api/console/projects/[projectRef]/managed-runtime/instances/[instanceId]/sessions/[sessionId]/events/stream/route.ts`.
It supplies fresh getConsoleApiAuthState→getConsoleWorkspace→existing managed-runtime
feature gate on every resolution. It does not change auth/issuer/configuration,
legacy feature roles, availability, or the organization-create gate reserved to
onboarding. Initial authentication denial remains HTTP401; denial after headers
is a generic SSE error and close, not a change to the HTTP status.

## Local evidence

- Unit stream/command regression19PASS/68assertions, no skipped tests.
- Private PG stream suite8PASS/47assertions with a zero-attempt fetch/preconnect
  guard. Admitted identity is synthetic; actual browser-session persistence,
  expiry/revoke and actual policy publications/current decisions are exercised.
- Scope A-only/B denial, nested session mismatch, UUID pin despite slug rename,
  revocation between load and emission, fresh reconnect, mode/org/human change,
  and unexpected delegation all covered. Test fixtures contain two inert
  completed commands only; their attempt counts remain zero and no operations
  are inserted. No runtime/host/model is contacted.
- Private cluster QpVJ9e stopped after migrations74→75, sentinel and repeat no-op.
  DB evidence remains outside Git. Typecheck has only the known baseline error
  in complete-runtime-config.ts13, already owned/fixed by onboarding.

## Sole-integrator follow-up

Compose this fixed commit after42991d54, without copying a dirty tree. The newly
added stream files and dedicated route are separate from onboarding's member
endpoints, shared auth/nav/schema/journal and creation feature-gate hunks.

Exercise the route in the combined Next request/SSO context with a private inert
fixture, including expiry/revocation while connected and reconnect. The local
source test does not prove the request-context lifetime of Next cookies/auth or
the new onboarding config consumer. No enabling a managed runtime is required.
Leave feature availability and AI-off intact; runtime/bridge/provider rollout,
other SSEs and queued-command authorization remain separate explicit gaps.
