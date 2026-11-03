# Project authorization — normative contract

Status: implementation in progress; no deployment, no existing grant changed.

## Authority and subjects

The customer's Console MUST own authorization. Commercial central availability
MUST NOT participate. Authentication, organization admission, project access and
policy administration are distinct. An owner/admin role MUST NOT implicitly read
projects. Identity MUST come from authenticated server adapters and current DB
membership; the request body MUST NOT supply roles, groups, binding or delegation.

The project catalog is `project.read`, `project.write`, `project.admin`. A grant
covers resources in that project only; it does not grant access to secrets,
installation administration, policy editing or another project. Action implication
is NOT implicit: grant read explicitly alongside write/admin when needed. Existing
Pages visibility/view/session/origin and Bases view constraints remain additional
ceilings, never substituted by project membership. Per-resource action catalogs
beyond these three project actions are not claimed by this cut. Organization
resources use their own typed actions: `organization.{settings,onboarding,sso,
credentials,installations,authorization}.{read,manage}`. These actions cover
configuration/metadata, NEVER disclosure of credential plaintext. There is no
synthetic project for organization administration.

Project creation uses the separate `organization.projects.create` action plus
explicit `project.read` AND `project.write` grants for the new resource. Creation
MUST evaluate all three on the current policy, retaining its transaction lock
through insert/default site/audit. It MUST NOT promote a legacy role, append an
implicit creator grant, or commit an unreadable orphan before checking access.
This first cut requires an explicit future-project rule for the creator and, if
delegated, the installation. Create-only grants do not imply data access. Narrow
"grant only projects I create" semantics remain a separate catalog/design gap;
do not pretend an all-future-project grant has that narrower meaning. First-user
bootstrap retains its twelve configuration grants and no creation/data grants.

Policy documents are validated, bounded, versioned JSON data. They contain explicit
user, policy group, stable role-ID, installation, agent and explicit service principals;
exact project IDs (or an explicit all-projects scope), typed actions and allow/deny.
No script, regex, custom matcher or arbitrary expression may be entered. Casbin is
the sole rule engine, in process, with a product-owned fixed model: at least one
applicable allow AND no applicable deny. No matching rule, invalid policy or missing
active revision MUST deny. Database/engine failure MUST NOT fall back to legacy
role checks. Roles have immutable UUID identity, editable name and explicit
members/group assignments with organization OR project scope. Membership role
names, including owner/admin, confer NO power and are not policy principals.
Renaming a role changes its revision, not its identity/grants. Organization-scoped
roles do not become project roles. Grants/assignments are published policy data.

Policy-managed groups are current data in the published document. OIDC group
claims are not silently imported: onboarding's snapshot is session admission,
not live SCIM. Any future mapping requires issuer-bound names and documented
refresh/revocation behavior. Removing a policy-group member affects new decisions.

## Member lifecycle extension (core contract, consumer integration separate)

`organization.members.read` authorizes only the minimal organization directory;
`organization.members.manage` does NOT imply read, policy administration, role
assignment, project access or token visibility. Editing membership requires BOTH
member actions. Settings read MUST NOT return the directory as a nested side
effect. Onboarding owns its separate DTO/query/endpoint and member UI.

Membership lifecycle MUST NOT publish or mutate policy assignments implicitly.
Role/group assignment remains an audited policy mutation requiring authorization
read AND manage. Combined lifecycle/assignment operations require every action
and a single atomic transaction; this core does NOT implement such a combined
operation. Legacy invites/role mutation without these adapters MUST stay denied.

The native transaction wrapper for membership-only mutations MUST acquire Fleet
then policy advisory locks BEFORE other membership/head locks. It revalidates
the active human and both member actions through the existing Casbin engine,
holds those locks through the effect, rejects policy-head changes by the effect,
then verifies at least one active human still has BOTH policy read and manage.
Inactive identities, nominal owner/admin, manage-only and explicitly denied users
MUST NOT count as effective managers. No surviving manager means rollback, not
an owner fallback. Concurrent removals/publication serialize on the same policy
lock. Adapters outside this wrapper are not claimed to enforce this guarantee.

The callback is trusted server code, never submitted policy/code from a client.
Onboarding still owns target validation, membership CAS/idempotency, before/after
audit, admission/session provenance and revocation. Errors MUST escape the outer
transaction to roll back the entire effect. No combined role assignment is
silently implemented via this wrapper. Authorization audit is transactional;
denials thrown inside the transaction roll back its audit too.

Bootstrap MUST use a fixed explicit list of the original TWELVE configuration
actions, independent of the growing catalog. It MUST NOT grant members read/manage,
project create/data, or any future action automatically. The initial manager must
publish a deliberate reviewed policy change for those powers. Exact bootstrap
receipt replay MUST NOT restore revoked grants or overwrite a later policy.

## Delegation

Linked identity MUST remain the human author; login/link is not a grant. Decision
is the intersection of human policy, installation policy and (when authenticated)
agent policy. Each lane independently requires an allow and no deny. The caller
MUST NOT claim an agent via an arbitrary request header/body. Installation/session,
binding status, bound user and org must be revalidated. An unresolvable named human
MUST NOT fall back to the installation owner for reads. Audit retains every lane.
Unattended service principals require explicit provisioning; no invented human.
The existing CLI transport authenticates an installation, not an individual agent.
Agent-lane evaluator tests are not proof of deployed agent attestation or of the
Ravi runtime delegating all decisions. Host execution safety remains local too.

### API key subjects

API key authorship MUST NOT establish ownership. Personal keys bind an admitted
user; institutional keys bind an explicitly provisioned organization service.
The service lane has only its own explicit policy, no creator/user/role inheritance.
Key scope intersects current subject policy; revoked, expired, unclassified or
legacy-hash keys deny. Personal deactivation and key issuance/use serialize with
the same Fleet/policy lock order. Reinstating membership MUST NOT revive keys.
Administration requires explicit organization.api_keys.read/manage actions and a
current browser session; bootstrap MUST NOT inherit these actions. Metadata reads
never return a stored secret. Issuance/rotation returns a new token once, without
persisting plaintext in receipts/audit. See [API-KEY-OWNERSHIP.md](API-KEY-OWNERSHIP.md)
for migration, runbook and acceptance. The server-only transactional use seam is
not an operational bearer endpoint; CLI/MCP/bridge transports remain unchanged.

## Policy control plane and lifecycle

Organization-wide policy managers are explicit document principals, not project
data readers. This first editor does not support project-scoped policy managers;
it MUST NOT pretend a project admin may grant org-wide permissions. Managers have
explicit authority to publish grants across this org. The `administrators` UI
shorthand compiles explicit authorization.read/manage grants into the SAME Casbin
engine; explicit deny still wins. A human with this authority can deliberately
grant project access through an audited policy change, but has none implicitly.
Protected bootstrap creates the first explicit organization grants in the SAME
transaction as verified identity, membership and consumed one-time setup attempt.
There is no initializer based on owner/admin or an absent-policy bypass. Existing
installations with memberships need a separately reviewed operator migration;
this partial package MUST NOT be deployed over them without it.
The last manager/current publisher MUST NOT be
silently locked out. Recovery after losing all managers is a separate audited
operator procedure, not an unauthenticated website endpoint.

Draft, simulation and publication are separate. Each uses a generation CAS;
publication requires the exact previewed draft and actor. Rules and revisions are
immutable after publication. Rollback republishes a prior document as a new
revision, never rewinds history. Idempotent mutations bind key + actor + input;
reusing a key for different input is conflict. Administrative audit contains
actor/revision/reason/digest, never credentials or raw request bodies.

Preview compares active policy with the candidate across both organization and
project actions. A separate legacy migration impact plan is still required;
this engine never interprets legacy role labels as grants. Existing explicit
memberships are preserved. No runtime `allow-all until configured` is permitted.
First rollout therefore requires an initialized/reviewed policy before
enabling the new binary. No destructive down migration or rollback to a binary
that ignores policy after activation is safe.

## Freshness and effects

No cross-request decision cache or cookie-frozen grants. Every request reloads
the active policy and active membership; publication becomes visible to subsequent
decisions. Lists filter BEFORE pagination/count; hidden projects must not influence
search/count/export results. Nested IDs resolve to their canonical project in DB.

A decision is an observation, not a reusable bearer capability. Effects require
reevaluation at the point of execution; transactions should lock the policy head
and membership state through commit where possible. Streams recheck before data
emission/reconnect; background jobs recheck before effects, not merely admission.
In-flight external calls cannot be unexecuted by revocation. Coverage and remaining
TOCTOU/stream gaps MUST be reported individually, not called instant revocation.
Console-local outage denies protected operations; commercial-central outage does
not. No remote runtime provider rollout is part of this task.

The managed-session SSE adapter MUST resolve the current browser session and
workspace before each load AND before each emitted batch (including the initially
loaded page and empty heartbeats). It MUST pin the original human, organization,
mode and canonical project/instance/session; a changed subject is a denial, not a
handoff. The emission check MUST reapply current project policy and nested scope.
Revocation or lookup failure MUST discard the pending batch and close with only
a generic unavailable event, never cursor/content/denial details. Cancellation
MUST discard pending asynchronous results and remove its listeners/timers.
This is a batch observation, not an atomic network transaction: bytes already
queued cannot be recalled, and a change after the final check may race that batch.
No claim about queued runtime execution, all SSE endpoints or instant revocation
follows from this one adapter. Testing it MUST NOT activate a managed agent.

The combined acceptance MUST exercise the dedicated Next route with a real test
SSO session, including request-context lifetime after headers, current expiry and
revocation, cursor reconnect and nested scope. Loaded-but-not-emitted and pending
cancellation tests MUST synchronize on an observed boundary, not assume a sleep
puts revocation at the right point. Inert completed fixtures MUST retain zero
attempts/operations. Test-network metadata checks from the framework MUST remain
blocked and be distinguished from provider/runtime attempts, never silently
excluded from a claim of zero outbound fetches.

## Integration and acceptance

Onboarding owns login/OIDC/bootstrap/Vault/Fleet and migration0073/journal74.
Authorization owns its separate module and proposed migration0074/journal75;
shared aggregate/journal/navigation edits require agreement. Never copy a dirty
peer worktree. Tests use private local fixtures, not staging/Mac identities.

Acceptance requires same-org A/B positives/negatives, filters before pagination,
role/group removal, invalid rules, CAS/replay, human/delegate intersection,
revoked/mismatched/expired delegated identities, native Pages/Bases ceilings,
policy UI edit→simulate→publish without redeploy, real DB fresh/upgrade/no-op and
joint onboarding regressions. Pure evaluator success alone is not end-to-end PASS.

Engine references (primary):
- https://casbin.apache.org/docs/syntax-for-models/
- https://casbin.apache.org/docs/supported-models/
- https://github.com/apache/casbin-node-casbin

Specs are versioned here because the publication deliberately excludes runtime
`.ravi` state. This file is the normative source, not a runtime permission grant.
