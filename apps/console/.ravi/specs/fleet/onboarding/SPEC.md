# Organization onboarding

The setup objective is a usable organization, not merely filled forms. The initial
guide MUST disappear after explicit completion, while settings remain accessible.
Optional or unsupported services MUST NOT block unrelated usable functionality.
Completion review MUST bind to the displayed snapshot. A conflicting or refreshed
snapshot requires a new explicit review; ordinary retry preserves the same intent.

The backend MUST persist and apply settings to their real consumers. UI-only
storage or mock connection success is not acceptance. Tests MUST identify their
scope: unit, local integration, browser fixture or deployed E2E. Deployment remains
with the staging owner and requires its own explicit plan/authority.

## Validation

Explicit policy success independent of role name; owner/admin without grants,
anonymous/cross-org/CSRF denial; read/manage separation; version conflicts;
retry identity; secret absence in responses/logs; Vault unavailable/sealed;
credential rotation/revocation; host-key mismatch; forbidden targets; timeouts;
SSO draft/test/activate/lockout; persistence/recovery; desktop/mobile/keyboard.

## Organization settings and member directory

Organization settings MUST expose only id/name/slug. They MUST NOT return member
or token/project arrays, including empty compatibility placeholders. Member
directory queries, DTOs, endpoints and consumers are separate. The fixed members
catalog/core handoff is required before its implementation is integrated.

`organization.members.read` grants only the necessary directory, not policy,
role assignments, project data or token metadata. Mutations that inspect a member
require read AND manage. Changing membership MUST NOT assign a policy role/grant;
policy assignment remains behind authorization.read/manage. Identity admission is
not policy assignment. Legacy upsert/invite endpoints that cannot meet this
contract MUST explicitly deny; mail/WorkOS/invite delivery remain unsupported.

Member lifecycle changes must be atomic, audited, concurrency/retry protected and
must preserve an active effectively authorized policy manager. A role named owner
is neither sufficient for this check nor a permanent exception. No hidden grant
addition in bootstrap: the original12configuration actions remain fixed; members
and project creation require explicit policy publication afterward. Existing
members/policies need an operator-reviewed activation plan, not automatic seed.

The guide MUST explain this distinction and link only to independently authorized
policy administration; publishing grants is NOT a mandatory completion step.
Lifecycle endpoints accept only an existing user/status/version/operation intent.
No policy/groups/role/actor fields. Current authorization precedes receipt replay.
Errors from the shared membership wrapper MUST roll back the outer transaction.
Deactivation revokes scoped Console/Pages/CLI/link sessions and pending admissions;
reactivation MUST NOT revive old sessions and may expose previously granted rights,
which the confirmation must disclose. Directory and last-manager checks are bounded
at1000 and fail closed, with no claim of unbounded scale or live IdP revocation.

Credential issuance MUST share the Fleet transaction lock with membership
deactivation, acquired BEFORE policy/membership/credential-row locks. Current
admission, source-credential checks, issuance and its success audit use the same
transaction. If issuance wins, deactivation revokes it; if deactivation wins,
stale admission cannot create a usable credential. Reactivation never resets
revoked credentials. An actual fresh login/approval remains possible.

OIDC browser provenance is the server-derived session ID, not a bearer token or
grant from a form. Member Page claims, capture sessions, CLI device approval and
link approval MUST revalidate that source when the initiating mode is OIDC.
Page claim consumption and session insertion/audit are atomic; consumed claims
are also revoked on deactivation, preserving their consumption metadata. Guest
Page admission remains a separate explicit grant contract, not invented org
membership. CLI refresh never changes status back to active and a revoked row
is terminal even inside the duplicate-refresh grace window. Link request creation
checks its current CLI session; approval takes Fleet before locking the request.

Concurrency acceptance MUST observe real PG blocking, cover both legal winners,
rollback of sources/effects/audit, old credential replay after reactivation and
new credential success. Configuration errors/timeouts/deadlocks cannot count as
access denials. The R1 original reproduction and its failure remain preserved.

Time-bounded credential admission MUST use a fresh wall clock after Fleet and
source-row lock waits, never a request-start Date or SQL transaction-start now().
The final admission checkpoint is inside the effect transaction, after effect
and success-audit writes; expiry/source checks there MUST roll back all effects
if a later write/row/audit lock waited past the deadline. Equality is expired.
This checkpoint is NOT atomic with the subsequent commit or network response.
Source consumption remains single-use and must roll back with issuance. User
CLI refresh follows the same Fleet/source-row order and cannot extend an expired
source session. Tests MUST cover Fleet, source-row and later write waits, valid
controls, expiry boundary, replay, rollback, and the original R1 serializations.

## Managed OIDC contract

Candidate testing is a real authorization-code login with PKCE, nonce, signed
ID token and verified email. It is bound to the initiating active admin session,
the exact connection revision and immutable credential version, and expires.
Activation is a separate explicit action. No discovery-only success activates.
The candidate identity must have the same verified email as the current admin;
the combination of both authenticated sessions authorizes linking that subject
to this existing user. A subject already owned by someone else is rejected.
No other user is created, linked by email, or promoted. Changing issuer may
require provisioning other existing members' subjects before they can log in.

`admissionGroups` is an issuer-bound admission constraint on EXISTING members,
independent of any role name. If nonempty, at least one group must match. Empty
means no additional group restriction, never a grant. Groups never create users,
policy groups or permissions. The validating administrator must pass the same
constraint. Obsolete `roleGroups` records fail closed; migration requires an
explicit operator-reviewed candidate, not an automatic widening of admission.
Signed group snapshots persist with the browser session and are checked against
current admission configuration on reads; IdP changes require fresh login or
revocation, not a claim of SCIM/live synchronization.

Managed OIDC server calls use only the issuer's exact HTTPS origin. No redirects,
cross-origin token/JWKS endpoints, IPv6, loopback, link-local or cloud metadata.
Private IPv4 requires an explicit checkbox. DNS is checked and the selected IP
pinned per request while hostname TLS validation remains enabled. The pinned
lookup MUST honor both Node single-address and all-address callback contracts;
test with the actual Node transport, not only an injected OIDC fixture. Unsupported
IdP topologies fail closed. No SAML/SCIM support is implied.

Active DB configuration is consumed on each request (no stale process cache of
the selection). No active record means the initial operator bootstrap config;
Vault or DB failure MUST NOT silently revert a managed connection to bootstrap.
Browser session checks do not need the client secret; login exchanges do.

## Bootstrap and recovery

The operator prepares root trust, Vault custody, canonical origin, org ID and
initial OIDC trust once. Routine updates then use the website. Initial owner
creation requires an operator-issued 256-bit token, stored only as a hash in DB,
expires in 30 minutes, and is bound to an expected verified email. Issuance is a
local explicit command, refuses any existing membership, writes a new 0600 file
under a 0700 directory outside the checkout, and never prints the token.
The public setup page exchanges that token for a bounded encrypted PKCE/state
transaction. Only a real login to the prepared issuer with the expected verified
email may atomically create the owner and consume the grant. Existing user or
subject collisions are rejected; no opportunistic email linking. No public grant
issuance, first-visitor ownership, or reuse for takeover of an existing org.

The same transaction creates the first explicit policy assignment and audit:
12 organization actions and no project grants. Its role label is informational.
Failure rolls back identity, membership, consumption and policy together. An exact
initializer replay cannot restore a subsequently revoked policy. Existing-member
installations require a separate explicit migration, never a legacy role fallback.

Bootstrap MUST lock its grant after Fleet, recheck grant expiry after beginning
the candidate login, and recheck BOTH grant and attempt deadlines after completion
effects/policy/audit. An IdP or database wait MUST NOT admit an expired first-owner
proof. Expiry must roll back identity, first grant, receipt, session and success
audit together. A fresh valid operator-bound attempt must still complete once.

Recovery of an existing installation is an explicit operator procedure, not a
second bootstrap via HTTP. Configuration fallback must never occur merely because
the coffer or IdP is unavailable. No Vault root token or unseal material is kept
by the app. Manual unseal custody versus external auto-unseal remains an operator
deployment decision; the local package must not invent it or hide it in a backup.
