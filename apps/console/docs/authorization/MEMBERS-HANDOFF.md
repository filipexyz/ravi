# Membership authorization core — additive integration handoff

Parent package: e2c2ef5 (after b4c9e117 and185beb9). No SQL/schema change, no
rewrite of delivered commits or migration0074. Only onboarding integrates the
shared member DTO/query/endpoint/UI and lifecycle. This is NOT a deployed member
service, SSO acceptance, or an alternate policy engine.

## Catalog and contracts

- `organization.members.read`: minimal member directory only. No project data,
  tokens, credential values or policy assignments. A dedicated DTO/query/endpoint
  is required; `organization.settings.read` must not include this directory.
- `organization.members.manage`: membership lifecycle only. Does not imply read
  or role assignment. An operation that reads to edit requires both actions.
- Assigning/removing policy roles/groups requires authorization.read AND manage,
  through the existing policy editor/store. A membership manager cannot call that
  API successfully without those grants. Never translate legacy owner/admin names
  into power. SSO membership admission is not a project/policy grant.

Existing `decideOrganizationInPostgresTransaction(tx, actor, action, requestId)`
and Drizzle organization decision adapters accept the two new typed actions.
Human identity/session provenance and target org resolution remain server-side.

`authorization/membership.ts` exports:

```ts
withAuthorizedMembershipMutationInPostgresTransaction<T>(
  tx: TransactionSql,
  actor: AuthorizationActor,
  requestId: string,
  effect: (tx: TransactionSql) => Promise<T>,
): Promise<T>
```

This is a server-only wrapper for onboarding's ALREADY OPEN native transaction.
Call it before acquiring any membership/head locks; order is Fleet advisory lock
→ policy advisory lock → current human/member decisions → effect → invariant.
It rejects delegation at this administrative boundary (no root/service-account
human substitute), requires members.read AND manage, and holds locks through
outer commit. It asserts the effect did not change the active policy head or
document, then checks current active user+org+membership against BOTH policy
read/manage through Casbin. Only an effective surviving human manager counts;
nominal owner/admin, inactive identities or manage-only/denied principals do not.
The bounded check fails closed above1000active members. It returns the effect's
value, not an authorization capability. No caches or independent connection.

An invariant/error must propagate out of the outer transaction: do NOT catch it
and commit the mutation. Rollback covers effects, business receipts and audit.
The wrapper writes decision audits and a `membership.authorization` audit with
policy revision/digest; the caller still owns target validation, exact before/after
business audit, CAS/idempotency, session revocation and directory minimization.
Its receipt/retry check belongs INSIDE the authorized effect, never before current
authorization. This helper alone is not proof of lifecycle replay semantics.
Policy changes combined with member lifecycle are intentionally NOT supported by
this wrapper; do not nest the independently committing policy store. An eventual
combined API needs every action, explicit transaction design and its own tests.

Membership activation does not insert/modify policy grants. Previously published
assignments to an inactive member can become usable again upon authorized admission;
the lifecycle UI must disclose that, not call admission a grant reset. Deactivation
denies the identity even if assignments remain recorded. No unauthenticated recovery
or existing-installation activation shortcut is added.

## Bootstrap: fixed original twelve grants

`BOOTSTRAP_CONFIGURATION_ACTIONS` in bootstrap.ts is an explicit fixed tuple,
not a filtered/computed catalog. It contains read/manage for exactly these six:

| Resource | Read | Manage |
| --- | --- | --- |
| Settings | organization.settings.read | organization.settings.manage |
| Guide | organization.onboarding.read | organization.onboarding.manage |
| SSO | organization.sso.read | organization.sso.manage |
| Credentials | organization.credentials.read | organization.credentials.manage |
| Installations | organization.installations.read | organization.installations.manage |
| Policies | organization.authorization.read | organization.authorization.manage |

No members actions, project create or project data. The bootstrap steward must
deliberately save/review/publish the additional grants in Access policies before
managing members or creating projects. The policy administration catalog/reference
selector is not a standalone directory API. Exact bootstrap replay returns its
original receipt without restoring any subsequently revoked configuration grant.
No retrogrant for existing organizations. No change to bootstrap admission or
ownership of its integration.

## Files / integration cautions

Catalog, bootstrap fixed list, membership wrapper and new unit/PG tests are own
files. `contract.integration.test.ts` changes ONLY assertions/new final replay test,
NOT the beforeAll preparation reserved to onboarding. Preserve the integrator's
schema-validation fixture patch when composing these hunks. SQL0074 and shared
journal/schema/auth/nav/members service remain untouched.

The policy editor consumes the shared catalog; its browser harness tests keyboard
selection and separate member-read grant at1280/390. This is the POLICY editor,
not a member directory/lifecycle UI. Joint onboarding tests remain mandatory.
Legacy member/invite paths without the adapter must stay explicitly denied; no
mail, WorkOS, invitations or active installation changes are authorized here.
