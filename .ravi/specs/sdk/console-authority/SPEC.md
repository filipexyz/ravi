---
id: sdk/console-authority
title: Console authority on the canonical gateway
kind: capability
domain: sdk
capability: console-authority
status: active
normative: true
applies_to:
  - src/sdk/gateway/console-*.ts
  - src/sdk/gateway/streaming/session-view.ts
  - src/cli/commands/session-conversations.ts
  - src/cli/session-targets.ts
owners:
  - ravi-dev
---

# Console authority

- CLI decorators remain the only command/schema catalog. Console invokes POST
  `/api/v1/<group>/<command>` through the same validator and dispatcher. No
  NDJSON operation protocol or fallback listener is accepted. A fixed restricted
  SSH command forwards HTTP bytes to the dedicated Unix socket; it has no access
  to the ordinary CLI socket, runtime database or credentials.
- A public runtime proof binds a fresh per-connection nonce and catalog digest
  to the pinned Ed25519 runtime identity. The catalog exposes reviewed
  `CommandAccess.consoleScope` boundaries. This marker describes supported
  resource resolution; it is not a grant or a local permission policy.
  Private conversation commands also declare `consoleOnly: true`. The ordinary
  gateway rejects them before body parsing/dispatch even with a valid runtime
  key. Generated OpenAPI declares Console delegation security, never ordinary
  runtime bearer authority as sufficient for these operations.
- Every request requires a signed Console decision with issuer/kid/audience,
  enrollment/epoch, subject/org/installation/project, exact canonical command
  and semantic action, resource scope, policy revision/digest, invocation origin,
  operation ID, creation time, exact HTTP method/target/body digest and a fresh
  one-use JTI. Delegations last at most 30 seconds. Local `rctx_*` is rejected
  by this listener; Console tokens are rejected by the ordinary CLI listener.
- Browser, channel and automation origins are typed and verified independently
  of any web session. Browser session IDs are provenance, not identity or
  authority. Channel delivery IDs and automation run IDs belong to the Console
  delivery layer; the runtime deduplicates its stable operation ID. This
  contract does not install or migrate live channel connectors.
- Console is the sole policy authority for these invocations. Control authority
  never uses local administrator fallback and never becomes a turn capability.
  Execution uses only current per-agent capabilities from the signed delegation;
  child attenuation, exact-action approval and lease revocation remain binding.
- Private sessions resolve through the durable enrollment/owner/project binding.
  Every command, including private conversation commands, MUST match the signed
  scope kind to its declared `consoleScope` before dispatch. Session authority
  MUST NOT admit project-wide listing, creation or receipt lookup.
  Names, aliases and local wildcard/admin grants confer no ownership. Ordinary
  session tools remain blind to private history. Reviewed existing configuration
  handlers resolve only the delegated session and cannot propagate to an agent
  or siblings. Unreviewed commands, `CliOnly` and `superadmin` deny by default.
- Admission of private sends persists message, execution row and receipt in one
  transaction. Same ID/different payload conflicts. Generic reviewed control
  handlers atomically persist the admission receipt and audit before effects.
  Failure to insert the audit rolls back the pending receipt, reports no effect
  and permits a safe retry. After admission commits, a crash before a final receipt is
  `EXECUTION_UNKNOWN` and must never trigger automatic replay. Both receipt
  namespaces reject reuse of an operation ID across command families.
- New policy restrictions commit before operation dispatch, even when dispatch
  is denied. Stale revisions cannot restore authority. Execution authority lasts
  at most 30 seconds plus the 250ms cancellation tick without fresh renewal.
  Reads and SSE reconnects do not renew execution leases.
- GET `/api/v1/_stream/session-view` exposes only the durable human projection.
  Signed cursor/target scope includes enrollment epoch, subject, project and
  conversation. Pull backpressure preserves journal position; no in-memory
  dropping, raw tools, reasoning or debug event streams. The stream ends on
  expired/revoked authority and must reconnect with a newly authorized grant.
- Execution/model credentials and private history remain on the installation.
  Console stores delivery identity/digest/status, not a private response cache.
  Replayed receipts still require current authorization.
