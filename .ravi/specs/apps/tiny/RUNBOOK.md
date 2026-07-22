# Tiny / RUNBOOK

## Current Decision

- GO: Ravi App is the canonical direction for neutral Tiny transport/contracts.
- GO offline: v2 `read-wave-1` has six promoted reads and a scoped parity suite;
  its ten other modeled reads remain outside the manifest/CLI until later waves.
- NO-GO live: even read-wave-1 remains blocked until F-001/F-002 are re-tested,
  a persistent broker backend/connection is provisioned and authorization is separate.
- NO-GO: production cutover, v3 live and every write/destructive operation.
- `sde tiny` remains baseline and fallback; business workflows remain outside the App.

## Provision A Tenant Safely

1. Create non-secret config at
   `$RAVI_STATE_DIR/apps/tiny/tenants/<tenant>.json` with `tenant`, `apiVersion`
   and `credentialConnection` only.
2. Provision the existing token in an approved keychain/Vault backend without
   displaying it, then register `provider=tiny`, `connection=<connection>` and
   the minimum read scope in the credential broker.
3. Verify metadata with `config-check`; do not copy token/client secret/access
   token/refresh token into tenant JSON, env committed to disk, logs or task artifacts.
4. Run `info --dry-run`, then one approved read-only live call and compare a
   redacted shape/digest with `sde tiny info`.

## Cutover Waves

1. **Broker readiness:** durable backend, active connection, minimum grants,
   audit event and fail-closed negative tests.
2. **Read shadow:** `info`, then low-risk contacts/products/stock reads;
   compare status, shape and redacted digest while returning legacy output.
3. **Read primary:** App becomes primary only after sustained parity and quota/
   latency/429 observability; legacy remains explicit fallback for availability,
   never for auth/business errors.
4. **OAuth v3:** o lifecycle de bundle/refresh/expiry/rotation já existe offline;
   provisionar consentimento, conexão, grants e revogação controlada e provar
   headers/auditoria antes de qualquer v3 live call.
5. **Low-risk writes:** only after an operation has official contract parity,
   idempotency/reconciliation, dedicated permission, preview review and a new
   explicit human authorization for a controlled write.
6. **Destructive writes last:** pedido, estoque, fiscal, financeiro and webhook
   each require their domain checklist, before/after evidence and compensation.

## Open Blockers Before Live Writes

- persistent credential backend/connection absent on this host;
- OAuth v3 sem consentimento, conexão persistente, grants, revogação e prova live;
- official public v1 contract not found;
- `conta-receber-baixar` official/legacy field mismatch;
- official public webhook v2 contract not found;
- tenant plan is not yet resolved at runtime; use the published per-plan v2/v3
  tables, conservative serial throttling and observed account headers/panel;
- webhook registration quota/headers remain unknown because no official REST
  registration contract was located;
- transport write handlers intentionally do not exist.

## Rollback

- keep `sde tiny` unchanged until each operation is proven live;
- switch the SDE adapter from App primary back to legacy without changing
  business workflows;
- disable the broker connection/grant for the affected tenant;
- reconcile any future uncertain write before retrying—never fall back and
  repeat a mutating request automatically.
