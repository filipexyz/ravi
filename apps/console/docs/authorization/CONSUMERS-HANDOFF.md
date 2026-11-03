# Consumer/editor handoff — additive to fixed core b4c9e117

Local review package, NOT release-ready. No deployment, SSH, runtime or real
grants changed. The integrator alone composes this commit with onboarding and
owns shared schema/journal/layout/auth/navigation. See ACCEPTANCE.md and
SURFACES.md for exact PASS, gaps and migration limits.

## Entrypoints and required grants

- Screen: `src/app/(org)/[org]/permissions/page.tsx`, wrapper
  `src/features/org/project-policy-screen.tsx`, editor `project-policy-editor.tsx`.
- API: `src/app/api/console/authorization/[[...segments]]/route.ts` forwards to
  `handlePolicyRequest`. Actor comes from authenticated server user/workspace;
  no body identity, no static console.settings feature as authority. GET uses
  `organization.authorization.read`; save/simulate/review/publish/rollback require
  explicit `.manage` AND `.read`. No-store, strict mutation Origin and body limits.
- `/api/cli/authorization/decision`: verified native CLI JWT, linked human and
  installation ceiling; current DB decision, not a bearer capability, cache0.
  Agent attestation/provider adoption are NOT implemented.
- Store.read adds `canManage` to hide edit controls for policy readers; backend
  still enforces every action. An authenticated user may load static shell but
  cannot obtain policy/member/project metadata without read permission.

## Proposed navigation diff — integrator applies, not this branch

1. Add `permissions` to the organization settings navigation with label
   **Access policies**, app path `/org/permissions`, canonical `/<org>/permissions`.
   Existing `orgPath` already maps this app path; do not add a global root route.
2. Drive visibility with a SERVER-derived
   `organization.authorization.read` decision. Do not reuse legacy
   `console.settings`, role names, or the list of allowed projects. A policy
   manager with zero project data must still reach this screen; a project reader
   without policy read must not see the entry or retrieve API data.
3. Keep edit controls tied to `canManage`; layout/navigation is affordance only.
   Shared layout should recheck current policy; never serialize a reusable grant
   into a cookie. Existing bootstrap/login identity remains separate.
4. Integrator owns OrgArea/console-paths/layout and the organization-settings
   hunks in read-model/settings/general API. This branch changes read-model ONLY
   project listing/audit/runtime/mail filtering. Merge hunks, not whole files.
5. `src/features/org/labels.ts` has a preexisting four-line help-copy diff from
   this front removing the assertion that membership opens every project. These
   bytes were preserved/reportable, not reverted. Integrator should align them
   with its final dynamic-role UI; they still describe remaining legacy member
   management behavior and are not proof that every nominal check was removed.

## Identity and delivery contracts

`authorizationActorFromWorkspace` retains current human and optional verified
delegation. CLI adapters call `projectAuthorizationFromCli` with authentication
results, never request JSON. Named unlinked reads no longer fall back to the
installation owner. Some legacy `lesserRole` restrictions remain additional
limits; no role label grants project access in this module.

Inbox protocol2 binds subscription to human+installation, scopes data BEFORE
count/pagination/watermark and rechecks ACK. Base subscriptions persist server
provenance, explicitly renew after credential refresh, and all new event keys
include subscription ID. Legacy Base items without a recipient remain stored but
deny delivery. Existing Ravi inbox clients need compatibility acceptance; do not
claim this wire change is already installed in the Ravi runtime.

## Reproduction / merge gate

Use the frozen Bun lockfile. Run the targeted unit suites and
`RAVI_AUTH_TEST_PG_BIN=<postgresql-bin> bun scripts/test-project-authorization.ts --consumers`.
This starts ONLY an isolated Unix-socket PostgreSQL and disposable browser; no
provider, user browser, remote CLI or real secret. Its74→75 migration sequence
tests the candidate after the baseline, not the joint76-entry integration.

The sole baseline typecheck error at complete-runtime-config.ts:13 is already
fixed in onboarding5c775113; do not duplicate it. Repeat typecheck/build and
real SSO/bootstrap/Vault plus policy regressions after fixed-commit composition.
Creation UI, existing-installation activation, every SSE/job and live Executor
transport remain explicit gaps; do not deploy this review package alone.

## Additive closure after185beb9 (apply the next fixed commit too)

- Adds the typed `organization.projects.create` control-plane action. Bootstrap
  deliberately EXCLUDES it and still seeds twelve configuration-only actions.
  Existing active policies gain nothing until explicitly edited/published.
- `authorizeProjectCreationInTransaction` uses the current head/identity locks,
  separately evaluates create then read/write for the exact new service-generated
  resource ID, and audits before insertion. createProject keeps insert/default
  site/audit in that transaction, does not add a role/membership/policy grant and
  returns the already-authorized new metadata. Site failure rolls back all data.
  The first contract requires explicit future-project grants, not an implicit
  owner or a claim of "only my newly created projects" support.
- CLI 403 now stays PROJECT_ACCESS_DENIED rather than becoming503. Linked creation
  requires both human and installation lanes; revoked link denies.
- Direct getArtifact closes a same-org-only path. listTokens refuses a missing/
  denied project instead of selecting all-org tokens. Only these PROJECT hunks
  in read-model changed; organization-settings branch remains the integrator's.
- settings.ts changes only imports and updateProjectSettings transaction checks
  (project.admin AND project.read), not updateOrganizationSettings. Merge minimal
  hunks with onboarding's changes. Authorization administrative handlers now also
  enforce manage AND read, so manage-only cannot read/simulate/self-grant.
- Required integrator follow-up: creation form and app-shell must use trusted
  action capabilities, not roleCapabilities names. Do not advertise browser
  creation acceptance from service/DB tests. No shared UI/layout change here.
