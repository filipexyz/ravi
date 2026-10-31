# Human bridge: compatibility and release boundary

The bridge is an opt-in protocol alongside the existing Console integration.
Installing this release does not enroll an installation, start the bridge
listener or move ordinary sessions to Console-managed permissions.

## Existing integrations

- `RAVI_HUMAN_BRIDGE=1` enables the private socket listener. Without a bridge
  context, permission checks and runtime events do not initialize its database.
- No existing HTTP route, authentication handler, cloud-auth flow or main SQLite
  migration is replaced. The generated API adds the context bridge hook method;
  enrollment commands remain local CLI operations.
- Ordinary runtime contexts still use their existing permission provider chain,
  chat-only ceiling, approval service, liveness/revocation and child attenuation.
  An agent named `console` is an ordinary agent; only the exact private session
  namespace or an explicitly validated bridge turn enters the bridge authority.
- Ordinary Codex sessions keep their existing hook feature configuration. Managed
  turns use a private profile with a guard that covers every native tool. The
  Responses provider secret is never part of the shell environment allowlist.
- The shared CLI loads `.env` from `RAVI_STATE_DIR`. The default remains
  `~/.ravi/.env`; an explicitly separate installation must provide its own `.env`.
  This intentional configuration correction prevents inheriting another
  installation's secrets. Existing deployments using a custom state directory
  while relying on the default home's `.env` must move that configuration first.

## Managed bridge contracts

The client must support `ravi-human-bridge/2` and match the pinned runtime and
issuer. Version 1 is intentionally rejected. Console decides permissions;
Ravi applies signature, owner/session scope, revision, lease and exact-action
approval. Local permission profiles cannot override a verified bridge decision.
Context revocation and isolation remain enforced. No other execution channel is
migrated by this change.

Bridge state is separate, under `human-bridge/bridge.db`; existing conversations
are never adopted. Receipts and journal must survive rollback. Stop new managed
work and disable the listener to roll back; do not replay uncertain turns.

## Evidence and limits

Focused tests cover ordinary authorization without bridge storage, agent naming,
Codex transport, context liveness, local chat-only denial, bridge grants and
expired/revoked context denial, signatures, receipts, isolation and approvals.
The publication checks also run the existing cloud-auth, Pages, CLI, SDK and
runtime regression suites.

A private environment passed 43 end-to-end checks with two explicitly synthetic
OIDC users, real UI, SSH, native runtime and a real Responses model. It exercised
owner approval, process cancellation and live Console permission revocation.
This is evidence for that tested build, not an execution of an existing hosted
Console deployment. Additional publication fixes are covered by focused local
regressions. No production service was deployed or modified for this review.
