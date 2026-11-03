# API key ownership — contract before implementation

27 October 2026; base `28cc2a9`. This is new authorized implementation, not a
re-run or approval of the previously denied independent R2 review. No deployment,
real key migration, service activation or secret custody is authorized.

## Inventory and reproduction

Full source/SQL search for `api_keys`, `apiKeys`, hash/prefix fields and bearer
adapters found only: schema/migration0000; `read-model.listTokens` (legacy project
settings metadata); `admin/projects` (org transfer); and the MCP membership fixture.
There is **no operational api_keys issuer or bearer validator in this snapshot**.
CLI uses cli_sessions, MCP uses mcp_oauth_tokens, channel worker tokens are a
different table, and provider API secrets are unrelated. No existing transport
may silently start accepting these keys.

Scope confirmed by the task integrator on 27 October: deliver operational Fleet
administration and the tested server-only transactional seam. There is no
requested bearer endpoint in this package. Do not create a demonstration route,
generic data API, administrator-as-holder adapter, or change CLI/MCP credentials.
HTTP acceptance below refers to administrative requests authenticated by OIDC;
`withApiKey` acceptance is isolated PG integration, never production bearer E2E.
A concrete future consumer requires a separately authorized resource/action
mapping and its own transport acceptance.

`tests/fleet/api-key-gap.ts` on unmodified main, PG17.10, Bun1.3.3 reproduced:
no subject fields; cross-org project accepted; creator suspension leaves the key
active. Evidence: own temporary directory `fleet-key-gap-ve0O6z`; cluster stopped,
Unix socket only. The initial fixture used an invalid enum role; that failed run
`fleet-key-gap-cWAWMC` is retained, stopped, and is NOT a security result. An active
row is not evidence of accepted bearer HTTP access where no validator exists.

## Minimal model and threat contract

- `created_by_user_id` remains authorship. Explicit `subject_kind` is
  `unclassified`, `user`, or `service`; exactly one corresponding subject FK.
  Organization membership binds a human. An org-owned service-principal row has
  its own identity/status and explicit policy grants; no borrowed human or role.
- Extend the existing policy principal catalog with service, using the SAME
  Casbin engine and explicit allow/no deny. No service policy-administrator
  shorthand, implicit creator grant, all-action default, or new IAM framework.
- Key scope is one exact project or its organization, with explicit bounded
  action names from the existing catalog. A key ceiling intersects current
  subject policy on every use. Cross-org projects/subjects and body-supplied
  actor/org/role/grants are refused; selectors never establish authority.
- New organization api-key read/manage actions govern browser administration,
  distinct from metadata for Vault credentials. Bootstrap stays at its original
  twelve grants. Grant editing retains policy read/manage and preview/publication.
- Mutations acquire Fleet then policy advisory locks before identity/key locks.
  Issuance, rotation, classification, revocation, membership deactivation and
  policy publication serialize consistently. Every protected use reloads current
  key, subject, org, project and policy; effects stay in that transaction. Expiry
  uses fresh wall time after waits and a final checkpoint after writes/audit.
- Suspension/removal atomically revokes exact personal subjects, never by creator.
  Reactivation cannot restore keys. Service deactivation is terminal and revokes
  its keys; creator suspension has no such effect. Revoked grants deny current use.
- Token bytes are cryptographically random, stored only as SHA256; plaintext is
  returned once on successful issuance/rotation, never persisted in audit or
  idempotency receipts. Exact replay returns metadata only; if the first response
  was lost, rotate explicitly. Historical hash encoding is not assumed valid.
- Old rows default to unclassified without deleting/revoking/inventing owners.
  New validation always denies unclassified and legacy-hash credentials. Explicit
  classification records subject/scope/reason but still requires rotation before
  use. No compatibility switch bypasses this. Rollout is blocked until inventory
  has no unresolved active keys or inconsistent bindings and operator plans are
  reviewed. No real rows are changed by this package.
- CAS plus operation identity binds actor and full intent; authorization precedes
  replay. Failure rolls back row changes, business audit and receipts. Availability
  failures are 503, never a permissive or stale fallback.
- Project transfer must not silently retarget credentials. Block transfer when
  key history exists until a separately designed audited migration is available.

Threats to test: confused deputy (creator vs holder), forged subject/org/grant,
nominal admin, stale/removed members, cross-project and cross-org access, unknown
ownership/hash, expired/rotated bearer replay, revoked service/policy, concurrent
issuance/use/suspension, transaction rollback and duplicate retries.

## Gestalt diagnosis, before UI changes

Rendered the current credentials and members components with installed Chrome at
1280 and390, using the existing isolated preview and synthetic data. Credentials
evidence directory `fleet-ui-before-g9Bp2G`; members `fleet-ui-before-J87ZtS`.
Component fixtures are not native login or production E2E evidence.

User objective: identify which person/service can use a key, grant the narrow
intended scope, and reliably terminate that access. Natural order: review pending
classification → choose subject → scope/actions/expiry → confirm → retain the
one-time token → dismiss the completed form. Service creation and grant publication
precede issuance. Completed forms and secret display disappear after acknowledgement.

Hierarchy is good in existing heading→section→form→primary button, but another
generic credential form would conflate stored provider secrets and inbound keys.
Use a separate authorized tab and a classification notice above the key list.
Proximity groups type/holder/status with each name; keep author as secondary detail.
Similarity: one row/card grammar, text badges, consistent buttons. Common region:
separate inventory, services and the active operation; never multiple open forms.
Continuity/alignment: one left edge and vertical form order, retaining navigation.
Figure-ground: neutral surface with one primary action; destructive controls remain
secondary until confirmation. Closure: explicit completion and return to inventory.
Symmetry: balanced row actions on desktop, stacked on mobile; equal-width cards
must not imply human/service semantics are identical. Common fate: a mutation
updates its whole row; revoke/suspend feedback must reflect affected keys together.
Pragnanz: subject + scope + state explains a key without backend IDs or Vault paths.

Conflicts: dense scope details vs scanning, creator proximity vs false ownership,
pending classification vs new-key CTA, short mobile viewport vs full review. Resolve
with secondary details, labeled author, pending-first warning and disclosure forms.
Existing type scale/contrast/rhythm are readable; reuse tokens and spacing, cap form
width, wrap names/scopes, no horizontal table. Native labels, keyboard focus,
dialog focus restoration, text+color statuses and live feedback are required.
Loading reserves space; empty state explains first action; unavailable/denied are
distinct; retry preserves intent; CAS conflict requires refresh/review. Read-only
shows inventory without controls. After implementation inspect1280/390, keyboard,
success/error/conflict/empty/loading/denied, and ensure no secret in inventory/audit.

## Delivery evidence

### Rendered follow-up before the final UX patch (27 October)

Inspected the actual Next/OIDC fixture inventory at1280/390 from the preserved
handoff. Proximity, similarity and common region correctly separate each key's
holder/scope from its secondary author and the separate service inventory.
Hierarchy, figure-ground, aligned card edges, vertical rhythm and mobile wrapping
are readable; no horizontal document overflow. Symmetry yields to a vertical
mobile task order. The shared navigation uses horizontal scrolling; no global
navigation redesign is part of this patch. Common fate is represented by whole-row
refresh after mutation. The list's short status text, however, can incorrectly
say Active after expiry; that violates semantic similarity and feedback.

Closure/continuity and keyboard accessibility need explicit focus restoration:
the initiating controls disappear while a form is open. On cancel, successful
non-secret operation, conflict refresh or secret-dialog dismissal, focus will
return to the stable inventory heading. Every operation form will focus its first
field. A passive expiry refresh will update badges without resetting input. Empty,
loading, denied and error boundaries remain distinct. Conflict retains fields and
intent until explicit refresh; retry must not generate a new operation identity.
Pragnanz: replace hash/protocol jargon with what the operator must do (retain the
single displayed secret; issuance alone does not connect a service). Do not add
competing CTAs or another modal/form. Validate keyboard, expiry, CAS and recovery
states in the rendered browser after these targeted edits.

## Operator runbook and rollout gate

This is not deployment approval. Before any deployment, take an authorized,
quiescent backup and verify the migration against an isolated copy. Keep earlier
migrations immutable. Migration0076 adds columns, constraints, a service table
and a terminal-state trigger; it neither infers holders nor deletes/revokes old
rows. Fresh/repeat and populated-upgrade acceptance are separate from real data.

1. Inventory every intended consumer first. This snapshot has **none** accepting
   bearer api_keys; do not activate an external consumer as part of this update.
   If a consumer exists elsewhere, stop rollout until its owner documents the
   resource/action mapping, cutover and rotation plan. The seam is not a route.
2. A currently authorized policy manager explicitly grants the operator
   `organization.api_keys.read` and `.manage`. Bootstrap still grants only the
   twelve configuration actions; no new key-management or data powers are implied.
3. In **Settings → Chaves de API**, review unclassified entries against records
   of the actual holder, not the author. Choose a current admitted person or
   create an institutional service. A new service has no powers. Publish its
   narrow grants in **Políticas de acesso**, reviewing the service impact.
4. Classify with an exact org/project ceiling, explicit actions, expiry and reason.
   This records the decision but keeps the legacy value unusable. Then rotate
   explicitly and deliver the newly displayed value once to the authorized
   destination. Lost response/exact replay returns metadata only: rotate again,
   never recover plaintext from a receipt, audit or database.
5. Resolve every active unclassified/legacy-hash/inconsistent-project entry. The
   inventory's pending count is an operational gate, not permission to ignore
   unknown external consumers. Check database bindings too; no real classification
   is executed by tests or migration. Do not activate with an unresolved plan.
6. Before any future consumer activation, prove its server-derived org/resource/
   action against `withApiKey`, never a client-supplied identity or action. Its
   effect must be bounded local SQL using the supplied transaction, not network
   I/O or another connection. The callback must not mutate membership/policy.
   Define consumer-level idempotency and test transport denial separately; this
   package supplies admission/audit, not generic idempotency for unknown effects.

Revocation: suspend/remove a person through the member lifecycle to revoke their
personal keys atomically; reactivation requires a new key. Suspending the creator
does not revoke institutional keys. Deactivate the service or revoke its explicit
grant to stop institutional use. Key/service revocations are terminal in this UI;
rotation invalidates the previous value immediately, with no grace overlap.
The SQL trigger additionally prevents reactivating revoked keys or changing an
already classified holder. Project transfer is blocked if any key history exists;
do not delete history to bypass this guard.

Rollback is **forward-safe**, not a down migration: retain0076, subject/hash/status,
revocation history and terminal trigger. Disable the new administrative UI if
needed, but do not route keys through older permissive code, drop the guard,
restore pre-revocation backups over live data, or reactivate old hashes. A future
bearer consumer must remain disabled until a compatible build is restored.

Read-only preflight examples (operator selects the intended org separately):

```sql
SELECT organization_id, subject_kind, hash_version, status, count(*)
FROM api_keys GROUP BY organization_id, subject_kind, hash_version, status;

SELECT k.id, k.organization_id, k.project_id
FROM api_keys k LEFT JOIN projects p
  ON p.id = k.project_id AND p.organization_id = k.organization_id
WHERE k.project_id IS NOT NULL AND p.id IS NULL;
```

No query selects hash/token values. The UI's selectors contain only minimal
names/IDs; ownership administration does not grant project content access.

## Validation boundaries

Historical reports remain historical. Linux gate remains open: Docker daemon was
already inactive and was not started. Tests use installed PG17/Node24/Chrome on
macOS and private Unix-socket clusters, sequential heavy processes with4GiB heap.
No global packages, real database, remote host or service activation. External
IdP/Vault custody/HA/DR/production remain outside this package. Pure suites may
use synthetic drivers; the administrative browser uses real local OIDC/Next/PG.
Explicitly injected HTTP503 tests loading/error/retry presentation only, not
server availability. No test is the previously denied independent R2 review.

### Acceptance matrix — this candidate, 27 October

| Surface | Observed result and limit |
| --- | --- |
| New ownership/use seam |17 PG tests/93 assertions: separate author/holder, cross-org/scope/body/role denial, service lifecycle, legacy classification+rotation, hash-only persistence, CAS/retry, both real lock orders for issuance/suspension and use/revocation, rollback/late expiry and known-key denial audit; no bearer HTTP consumer |
| Project transfer |Both live PG lock orders against actual `moveAdminProject`: issuance wins→transfer refused; transfer wins→old-org issuance refused, no orphan/following key |
| Policy availability |Missing/corrupt active policy returns503 and does not execute the effect or fabricate a policy denial |
| Baseline/candidate regressions |Exact main28cc2a9 export and candidate each227/227 across metrics, six Bases/chat files, service-principal and MCP; separate owned PG clusters, unchanged test files |
| Policy consumers/editor |14 PG tests/169 assertions plus12 browser scenarios at1280/390; service-aware policy publication also exercised by real Next HTTP acceptance |
| Isolated suites |109 tests/589 assertions: Fleet, HTTP, OIDC, cost/digest, loopback SSH, engine/membership and MCP; no shared installed database, no remote SSH |
| Fleet integration |17 tests/381 assertions: Fleet5/59, bootstrap1/65, upgrade1/18, org3/27, members5/41, prerequisite1/14, Next/HTTPS/local-IdP/browser/restart1/157; Fleet5/59 also repeated in the SAME cluster |
| New administrative UI/HTTP |Real OIDC session and routes: denied/read-only/management, keyboard issuance, one-time token and secret-free logs/audit/receipt, invalid authority fields, scope/org negatives, CAS conflict+explicit refresh, legacy classify/rotate/revoke, independent service policy/revoke and permission-loss retry |
| Rendered feedback |1280/390 inspected before/after. Stable focus after cancel/dialog/conflict refresh, expired status changes while open; no document overflow. Loading/503/retry additionally checked with clearly synthetic503, real route restored before retry |
| Static/build |TypeScript with4GiB heap PASS; ESLint31 changed source files PASS (schema delta repeated); final standalone Next compile/TypeScript/118 generated pages PASS, one worker, empty private PG socket/no live DB |
| Secret hygiene |Gitleaks8.30.1 official local binary checksum verified.1701-file candidate snapshot:17 raw findings, each matched existing path/rule/line-SHA review, zero unclassified/new; raw exit1 is NOT claimed as zero findings. Commit-range scan is verified separately before push |
| Resource/safety boundary |Every fixture owns its cluster and closes it; no default DB, staging, daemon/VM start, runtime provider, real key, deployment or independent R2 acceptance |

Failures retained, not erased: initial TypeScript exposed a policy variable named
`document` shadowing browser DOM references (test-only rename); membership unit
expected the old catalog remainder (now explicitly excludes the two new key
actions from the fixed12 bootstrap grants); first consumer invocation lacked the
installed Chrome path and failed that scenario (rerun with explicit local path
passed). Earlier handoff tests precede the savepoint patch;17/93 is the later
candidate proof. Private artifacts contain synthetic login material and are NOT
published with the source. Build/lint/scan/publication evidence is recorded with
the final handoff; a build is not operational bearer acceptance.

### Reproduction commands

Use an already installed PostgreSQL16+ tool directory and Node24+; for browser
acceptance set `FLEET_TEST_BROWSER_EXECUTABLE` to an installed Chrome/Chromium.
The runners create/stop their own Unix-socket databases and reject missing binary
prerequisites. Do not point them at a shared DB or start a global Docker daemon.

```sh
FLEET_TEST_POSTGRES_BIN=/path/to/postgres/bin bun tests/fleet/run-postgres.ts --api-keys
FLEET_TEST_POSTGRES_BIN=/path/to/postgres/bin FLEET_TEST_BROWSER_EXECUTABLE=/path/to/chrome bun tests/fleet/run-postgres.ts --browser --repeat
FLEET_TEST_POSTGRES_BIN=/path/to/postgres/bin bun tests/review/run-bases-regressions.ts
bun tests/review/run-correction-units.ts
RAVI_AUTH_TEST_PG_BIN=/path/to/postgres/bin FLEET_TEST_BROWSER_EXECUTABLE=/path/to/chrome bun scripts/test-project-authorization.ts --consumers
NODE_OPTIONS=--max-old-space-size=4096 bun run typecheck
```

The baseline comparison used an exact `git archive` of main28cc2a9 with the same
unchanged lockfile/dependencies and an independent private cluster. Current
evidence is macOS/Bun1.3.3/PG17.10/Node24.11.0, not Linux or Bun1.4.4 execution.
The declarative Drizzle metadata mirrors0076 checks/indexes/composite FKs; the
terminal-state trigger is SQL migration logic, not a generated down migration.
