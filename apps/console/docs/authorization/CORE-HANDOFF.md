# Partial core contract for the onboarding integrator

Status: local contract/core only; NOT release-ready. This commit deliberately
does not enable routes, replace production consumers or modify aggregate schema,
journal, auth, navigation, onboarding or staging. It is suitable for a fixed-commit
local integration by the sole integrator, not for deployment.

## Fixed integration ownership

Onboarding commit `5c77511357a68d214a7a8cb2f566744981b3c4ef` owns its services,
OIDC, bootstrap admission, shared schema/journal and navigation. The integrator
applies both fixed commits in a separate worktree; do not copy dirty files.
Order: baseline74 entries → onboarding0073/idx74 → authorization0074/idx75,
`when:1792795000000`. Verify actual contents/order/drift before migration.
This package adds six tables; add the exports from `authorization/schema.ts`
to the aggregate only in integration. No baseline migration is rewritten.
Casbin5.51.1 is pinned by Bun. Lockfile adds its transitive dependencies and
relocates buffer5.7.1 under unbzip2-stream while Casbin uses buffer6.0.3.

## Server contracts

`src/server/console/authorization/store.ts`:

- `decideOrganizationInTransaction(tx: AuthorizationExecutor, actor:
  AuthorizationActor, action: OrganizationAction, requestId: string)`.
- `authorizationStore.withAuthorizedOrganization(actor, action, effect, requestId?)`
  owns a Drizzle transaction, keeps active policy/identity share locks through
  the effect, commits a denial audit before throwing403 outside the transaction.
- `decideInTransaction` / `withAuthorizedProject` retain canonical project
  resolution and verified human∩installation ceilings. Observations are not
  reusable capabilities. No cross-request cache or timeout-to-allow.
- Versioned draft/save/simulate/preview/publish/rollback use CAS + actor/input
  idempotency; publication rechecks the preview and publisher's explicit policy
  authority. Project and organization impact counts are returned separately.

`authorization/postgres.ts`:

- `decideOrganizationInPostgresTransaction(tx: postgres.TransactionSql, actor,
  action, requestId)` is the native adapter for existing Fleet transactions.
  It does NOT create another transaction/connection or change driver parsers.
  It uses the same policy/Casbin engine and current DB membership/head locks.
  This adapter intentionally rejects delegated CLI actors; Fleet human browser
  adapters derive user/org from the authenticated server context, never the body.
  Caller must check `.allowed` before any read/effect. Returning denial out of the
  transaction before HTTP403 preserves its audit; throwing inside rolls it back.

`authorization/bootstrap.ts`:

- `initializeAuthorizationInBootstrapTransaction(tx: postgres.TransactionSql,
  {organizationId,userId,identityId,attemptId})`.
- Insert in `BootstrapService.complete` AFTER validated issuer/subject/verified
  email, creation of identity/user/membership and consumption of the matching
  `fleet_bootstrap_grants` attempt, BEFORE returning/committing the session.
  An error rolls back the ENTIRE bootstrap. Do not call after commit or from a
  new HTTP endpoint, from role selection, recovery, or routine login.
- Takes the Fleet lock then authorization lock; verifies consumed matching attempt,
  first membership and current-transaction row versions, then inserts immutable
  policy revision/head/unique receipt/audit. It does not verify OIDC itself; that
  remains the protected onboarding admission boundary. Row-version checks prove
  writes in this transaction, not independent cryptographic identity provenance.
- First policy explicitly assigns a generated stable organization role to the
  verified first human, grants the 12 organization actions and ZERO project data
  permissions. Role name is merely a label. Exact receipt replay never regrants
  or resets later policy. Other identity/attempt/old membership fails closed.
- This is for EMPTY-org bootstrap. Existing installations with members are not
  silently initialized. An audited migration/activation path remains a gap.

## Actions for the integrator's adapters

| Resource | Read | Manage |
| --- | --- | --- |
| Org configuration | organization.settings.read | organization.settings.manage |
| Setup guide | organization.onboarding.read | organization.onboarding.manage |
| SSO | organization.sso.read | organization.sso.manage |
| Credential metadata/configuration | organization.credentials.read | organization.credentials.manage |
| Installation configuration | organization.installations.read | organization.installations.manage |
| Authorization policies | organization.authorization.read | organization.authorization.manage |

Read is NOT implied by manage. Credential plaintext is NEVER exposed by either
action. Existing Vault secret broker/use ceilings remain additional controls.
Replace nominal owner/admin checks at each consumer, not just UI visibility.
Do not expose OIDC groups until a server-only, issuer/session/membership/freshness
adapter exists. Current policy groups are explicit versioned assignments only.

## Local evidence and honest boundaries

Run `bun test src/server/console/authorization/engine.test.ts` and
`RAVI_AUTH_TEST_PG_BIN=<postgresql-bin> bun scripts/test-project-authorization.ts --contract`.
The runner creates a private Unix-socket-only Postgres cluster, migrates baseline
and this candidate, preserves a sentinel row, repeats as no-op, and stops it in
finally. Bootstrap tests use the exact prerequisite table shape from0073 but a
SYNTHETIC admitted identity fixture. They are NOT the IdP/bootstrap integration.

Proven here: same/different concurrent first claims, transaction rollback of
identity+membership+policy+audit, exact receipt replay, rejected separate-transaction
initialization, no owner/admin name grant, custom role rename/scope, A/B, separate
organization actions, current revocation via both adapters and HTTP, CAS,
self-lockout denial, invalid policy, human∩installation∩attested-agent evaluation.
Agent evaluator input is server-only; no agent attestation/provider was deployed.

Pending: onboarding integration/regressions; UI updated for role IDs/org impact;
all consumer enforcement/retests; migration of existing installations; stream/job
freshness coverage; real Ravi remote authorization provider. Earlier branch tests
of Pages/Bases/inbox/editor are historical and must be repeated for this contract.
Baseline typecheck error in complete-runtime-config.ts is already fixed ONLY in
the onboarding commit; do not duplicate that change here. No full-build PASS is
claimed by this partial package.

Next commits will update own consumers/tests and policy UI; shared navigation
proposed entry remains `/[org]/permissions`, authorized by
`organization.authorization.read`, edit controls by `.manage`. The integrator
alone edits OrgArea/console-paths/layout. No deploy/push/SSH is authorized here.
