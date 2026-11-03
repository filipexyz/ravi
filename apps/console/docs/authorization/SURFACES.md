# Enforcement inventory — coverage is not universal acceptance

Base05aa5ba, core handoffb4c9e117. Source and local tests only; staging untouched.
This inventory supersedes the initial temporary-helper notes.

## Implemented current boundaries

- Shared project-access resolves resource org/current policy/current active
  identity. List filtering occurs before caller pagination/count/search. UUID/slug
  lookup is org-scoped. Removed org-global listing and role-only bypass helpers.
- CLI actor refuses named unlinked humans on reads and preserves the verified link
  even for installation owner=actor. Project/Pages/publish/Knowledge/Bases/inbox/
  sync/watch/runtime-trace/feedback/library/meetings/cloud adapters carry verified
  installation+session+JTI+binding, never body principals.
- Pages and publish repository authorization ports use the current decision engine;
  publish's transaction adapter holds locks. Final persistence rechecks after
  storage promotion, including non-activating artifact finalization.
- Page CLI read rejects same-org member route shares that bypass project policy,
  and all cross-org delegated reads, even with a share. Generic Page share checks
  also retain project ceiling for any existing org membership (removed members
  cannot become guests). Explicit outside-org HUMAN shares and public routes are
  preexisting independent visibility boundaries, not new implicit permissions.
- Repeated project checks in knowledge, managed instances/runtime commands,
  ravi-control-chat and Page access diagnosis use injected canonical policy ports.
  Those old subsystems are NOT activated as part of this work.
- Managed-session SSE now re-resolves the browser session/workspace before loads
  and emissions, pins human/org/mode/project UUID/instance/session, and rechecks
  current policy and nested scope before every batch (including initial/empty).
  Revocation discards the pending batch with a generic error; cancel discards
  asynchronous results and cleans listeners. Real private PG/session-store proof
  is in STREAM-HANDOFF.md; actual Next+SSO route acceptance remains with the
  integrator. The existing managed-runtime feature/availability gate remains.
- read-model, calendar, feedback and watches filter aggregate project lists.
  Direct artifact lookup now uses project policy before hydrating metadata; denied
  project token lookup cannot fall back to an all-org query.
- Project creation requires explicit organization.projects.create PLUS read/write
  for the exact new server-generated UUID under one transaction. No creator role
  or hidden policy mutation; a default-site failure rolls back project/site/audit.
  First bootstrap remains12 configuration grants, no create/data grant.
  Project-settings effects recheck project.admin+read in their transaction.
- Bases intersect project decisions with existing view/site/action restrictions.
  Management and row mutations recheck inside the write transaction, before even
  returning an old idempotency result. Stale scopes do not preserve grants.
- Base subscriptions carry server-written actor provenance; delivery rechecks
  session/link/installation/current policy. Identity includes human+installation+
  canonical filter. An explicit authorized create renews the SAME human's stored
  proof after token refresh, with audit; never silently becomes another user.
  All new Base events retain their subscription ID in dedupe/payload. Inbox
  filters active matching human/install subscriptions before counts and cursors;
  recipient-less legacy Base events are not delivered. Two humans with the same
  project grant on one installation were tested independently.
- Page comment delivery uses persisted verified CLI provenance, not installation
  owner-role lookup. Legacy/missing proof denies. These are bounded continuations:
  session refresh/expiry/revocation stops them until explicitly reauthorized.
- Inbox v2 subscriptions bind human+installation. Authorized metadata is selected
  BEFORE payload/count/pagination, with scoped ordinals/etag and fresh ACK checks.
  Hidden B events do not change A watermark/count. Null-project events deny;
  >20k visible candidates fail closed. Legacy global subscriptions remain stored
  but are not reused. This wire revision needs Ravi-client integration.
- /api/console/authorization + /[org]/permissions: server actor, strict Origin,
  no-store, read/manage separation, CAS/draft/simulation/impact/publication/revision
  history. UI uses policy role IDs/assignments, not org role-name presets.
- /api/cli/authorization/decision: actual CLI JWT + linked author and installation
  ceiling, typed project action, current DB state, no cache/reusable capability.
  It does not authenticate individual agent IDs and is not a live Ravi provider.

## Real local acceptance versus adapter coverage

Real private PostgreSQL: A/B policy, role/group removal, CAS/rollback, direct HTTP,
native JWT tamper/expiry/org/link/install negatives, Pages site/nested Base/view/
row retry+revocation, scoped inbox delivery/ACK and stored subscription proof.
Browser at1280/390: real editor+HTTP+PG, but synthetic session, NOT SSO/Next shell.
Engine and service unit fixtures are separate from real DB security tests.
Publisher storage revocation test is in-memory storage/repository, not live S3.
No new end-to-end Executor HTTP/signature loop is claimed by these tests.

## Remaining explicit gaps (not PASS)

1. Sole integrator must compose onboarding's fixed commit, schema/journal/nav and
   its organization-action adapters, then test real bootstrap/SSO/Vault with this
   policy. No raw credential read action exists.
2. Existing member-bearing installations require audited policy migration and
   activation. This branch denies an absent active policy; protected first-user
   bootstrap is NOT a backdoor for an existing organization.
3. Legacy org-role-name checks still exist in specific subservices: cloud-run
   ownership/admin rules, feature-access/admission, library/admin controls,
   GitHub integration administration, and other non-project control planes.
   Project policy is an additional ceiling, not proof that every legacy label
   privilege has been removed. Their finer action catalogs/adapters need review.
4. Queued managed/cloud/knowledge work, SSE endpoints other than the bounded
   managed-session adapter above, shared-asset signed URL lifetime, and internal
   NATS transport are not globally policy-revalidated yet.
   No instantaneous revocation claim. Inbox v2/new subscriptions need client
   compatibility acceptance, including grant-change cursor behavior.
5. Several services check current policy before a later operation without keeping
   the transaction open. withAuthorizedProject/Organization and Bases writes do;
   arbitrary external effects already admitted cannot be unexecuted. Page storage
   objects promoted before a revocation may remain unreferenced; activation is
   separately gated. Test/close each TOCTOU surface before production claims.
6. Stable service principals, individual-agent attestation and a runtime Ravi
   permissions-provider rollout are future integrations. No root/service account
   substitutes for the linked human. Existing host execution safeguards remain.
7. Creation's backend service is covered, but its existing shell/form still have
   role-based affordances for the integrator to replace. The initial contract
   requires explicit future-project data grants; "only projects I create" and
   automatic narrowly scoped creator grants are NOT implemented. No hidden
   policy rewrite or synthetic role is used to hide that limitation.
8. Membership core now exposes members.read/manage and a native transactional
   lifecycle guard; onboarding owns directory DTO/query/endpoint/UI and actual
   lifecycle receipt/CAS/session revocation. Legacy member/invite consumers are
   NOT automatically migrated by adding these actions. See MEMBERS-HANDOFF.md;
   unaudited role-name/invitation paths must remain denied in integration.
9. No SSH/deploy/provider calls/model turn/new Slack/production changes occurred.
