# PR1 human-review corrections

This is implementation of the human review of `6feb17e`, not completion of the
blocked independent R2 review. Original failures remain evidence. No deployment,
AI enablement or production benchmark is implied.

## Contract before implementation

1. Internal Base jobs use server-created, non-serializable service authority,
   scoped to one org/project, named job, allowed Base slugs and operation set.
   A generic system caller, client body or role name never grants that authority.
   Jobs retain source/request identity and row/audit provenance; they never borrow
   a human owner. Metrics and shared-room projection remain separate jobs.
2. PG fixtures publish explicit policies. View restrictions, current membership,
   CLI delegation, idempotency, approvals, agent columns and events remain tested.
   Baseline test inventory includes dynamic discovery and failed hooks, not just
   source-line counts. No skipping assertions to turn the suite green.
   Restricted view writers require explicit `bases.view.write` plus project read
   AND the view contract; this action grants neither direct rows nor management.
   Existing `project.write` retains its documented management meaning. Without a
   separate action the old gate makes safe form writers into Base managers.
3. External I/O uses authorized short preparation and short finalization, outside
   the transaction in between. Finalization rechecks current identity, policy,
   deadline and configuration/credential revisions. No stale result publication.
4. SSO feature availability is distinct from action authorization. Custom labels
   with explicit grants work; owner/admin labels without grants do not.
5. Successful read polling must not produce unbounded duplicate audit rows.
   Denials, administrative mutations and important effects remain attributable.
   Retention/integrity is documented without deleting any installation data.
6. Only validated compiled policy content is cached, bounded and isolated.
   Decisions, membership/delegation facts and active revision selection are not
   process-cached. Revocation is checked against current facts.
7. Human credential revocation is atomic and use-time checked. Creation of an
   institutional key does not establish human ownership. Reactivation does not
   revive revoked credentials. No MCP service is enabled by these changes.
8. Fixtures own their databases and use explicit binaries or PATH with version
   preflight; no default database, global installs, external hosts or secrets.
9. Single-org trust conflicts fail closed. Idempotency key derivation separates
   domains, with an explicit persisted-receipt transition rather than lost retry
   identity. Inactive member assignments cannot create usable grants.
10. SSH retains pinned address/hostkey and explicit port constraints. Revoked
    secrets cannot be consumed, but physical Vault destruction stays an operator
    decision. Legacy role UI cannot promise authority the policy engine ignores.

Bootstrap stays at 12 explicit configuration grants. Last-policy-manager protection
stays intact; additional suspension requirements remain a product question.

## Evidence status

Luís reported Linux/Bun1.4.4/Node22/PG16 results: metrics main3/3 vs PR2/3;
six Bases/chat files main221/221 vs PR153/215. These are attributed review results,
not our rerun. Own baseline reproduction and per-finding matrix follow below.

### P1 reproduction and implementation (own runs, 24 October 2026)

Same isolated environment: macOS arm64, Bun1.3.3, Node24.11.0,
PostgreSQL17.10; Unix sockets, 32MiB shared buffers, no installed DB or staging.
Command: `FLEET_TEST_POSTGRES_BIN=<PG16+ bin> bun tests/review/run-bases-regressions.ts [source]`.
Each run stops its owned cluster and retains logs/JUnit. Main source was an exact
`git archive 05aa5ba` export, not edits to another worktree.

| Source | Metrics | service | workflow | review | widget | compiler | chat store |
|---|---:|---:|---:|---:|---:|---:|---:|
| main05aa5ba | 3/3 | 26/26 | 15/15 | 20/20 | 7/7 | 149/149 | 4/4 |
| unmodified6feb17e | 2/3 | 0/26 | 0/15 | 1/20 | 0/1 hook | 149/149 | 3/4 |
| P1 working candidate | 3/3 | 26/26 | 15/15 | 20/20 | 7/7 | 149/149 | 4/4 |

The six suite files are byte-identical between main and6feb. The difference
221→215 is **seven widget tests replaced by one `(unnamed)` beforeAll failure**
(`createBase` denied), not six removed/ignored cases. JUnit identifies these seven:

- saving a binding by ref stores ids, returns keys and the current ref, and audits widgetItemId
- refs resolve by itemId, by bare slug (the project, then the organization), and by project slug
- items of another kind, organization, or project, archived, unpublished, or missing are rejected
- mapped columns must be projected and accepted by the widget field; unmapped required fields are fine
- table layouts and unnamed widgets are payload_invalid; binding needs base.manage and the view version
- archiving the bound widget later leaves the view valid; a rename keeps the binding; re-sending it is checked again
- property dependents list views whose widget maps the property

Evidence directory suffixes under OS-private temp: baselinePR `fleet-bases-review-6FYu0q`,
baselineMain `fleet-bases-review-ALlB89`, finalP1 `fleet-bases-review-OvOukI`.
Intermediate failures Ny61Oz/rOPqAV/yrOAij remain retained. No skipped assertion.
Final P1 also passes one additional real-PG service-principal test (scoped effects,
one receipt on retry, provenance and denied lifecycle/stale-project operations).
Compiler is a SQL compiler suite and needs no actor policy. Chat store invokes the
real internal projection capability and needs no borrowed human grant.

Fixture policy grants are explicitly published through draft/preview/publish after
test-only policy-administrator initialization. CLI tests create genuine database
session facts, not a user-id-only mock. This is not a native login E2E claim.
Two additional mismatches were exposed: view-as accidentally inherited the
administrator's CLI session, and event expectations predated per-subscription
inbox deduplication. View-as now evaluates the target as a read-only human while
retaining the manager's audit identity; exact event expectations include the real
subscription id. Neither authorization nor replay protection was weakened.

### Decision cost contract

The immutable compiled-policy LRU holds at most16 entries and2MiB serialized
content; each request validates current revision/digest and current identity.
No membership, active revision, token or decision is cached. Native org access
loads a transaction-local snapshot once (3queries rather than45 reads for15
actions). Project listing batches project memberships and delegation facts rather
than fetching them once per project. Effects retain current share locks until
their short database transaction completes.

Allowed `.read` decisions and successful navigation observations do not write
decision-audit rows. Denials, write/manage decisions and operation audits remain.
A filtered project read list writes no row (visibility, not a refused attempt);
non-read listings keep one summary, never a row per project. Bases capability
probes (`project.write`, `bases.view.write` on every request) are `probe` mode
and write nothing; a denied `project.read` and a management refusal inside the
effect transaction are still recorded.
This does not promise zero writes for repeatedly denied requests. Application
operation/audit logs are not replaced by UI visibility checks.

Local doubles: `bun test tests/review/authorization-cost.test.ts` proves15 actions
use3 queries/1 compilation/0 successful-observation writes; denied read and actual
manage still write. It also checks immutable isolation, revision invalidation,
inactive facts, eviction and5760 allowed poll decisions→0 audit writes. These are
bounded test counts, not a production latency or capacity benchmark.

### Audit lifecycle / secret retention

No retention job, deletion or FK migration is applied. Authorization audit and
revision actor references intentionally remain `ON DELETE RESTRICT`: suspension
and credential revocation, not physical user deletion, are the supported lifecycle.
Operator policy must define retention/export windows and tamper-protected external
copies before any future pruning. Runtime append permission must not imply delete;
DB-owner access is not claimed tamper-proof. Policy revisions referenced by audit,
receipts or active heads must remain recoverable. No retention period is chosen for
the client. Revoked Vault data remains retained; application metadata denies its
use. Physical KV destroy/metadata-delete requires a separate custody/backup plan.

## Finding matrix — implemented corrections and remaining gates

Commit mapping is recorded in the publication section after the code commits.
PASS below describes local tests, never independent R2 review or deployment.

| Finding | Reproduction / cause | Correction and own verification | Remaining limit |
|---|---|---|---|
| 1 Jobs | Reproduced metrics2/3 and projection3/4 on6feb; generic system has no human grant | Server-created WeakMap capability, named job/project/Base slug/operation scope; metrics3/3, chat4/4, additional PG scope/provenance/retry test | Generic system remains denied; no AI runtime enabled |
| 2 Fixtures | Reproduced153/215 vs221/221; failed widget hook explains six missing cases | Explicit published policies, genuine CLI session facts, view-only action; all six221/221 and metrics3/3 | Other legacy host/operator/password/capture suites not rerun here |
| 3 Locks | Code confirmed Vault/DNS/SSH/IdP inside org transaction | Short reservation → I/O outside transaction → current identity/session/policy/config/credential/lease CAS; seven PG barrier tests28 assertions | Not a latency benchmark; crashed external writes need reconciliation, not blind retry |
| 4 Callback | Route used legacy feature role gate before policy | Availability-only gate; actual completeTest authority; route3/12 plus real PG policy/SSO lifecycle | Real client IdP not homologated |
| 5 Audit | Code wrote allowed polling/navigation decisions | Allowed reads/observations suppressed; denies/manage/effects preserved;5760 successful poll decisions cause0 decision writes in unit test | Repeated denials still recorded; no retention deletion job or physical-user deletion |
| 6 Cost | Code rebuilt Casbin per decision and queried each project | Immutable content LRU16 entries/2MiB;15 org actions3 queries/1 compilation; real PG2 and22 projects both6 queries | Cache bound measures serialized input, not total process RSS; no decision/fact cache or production benchmark |
| 7 Suspension | MCP human token was not revoked/rechecked by Console tool path | Atomic exact subject/org token revocation; signed internal handler revalidates token/membership/bridge/project/scopes; real PG1/13 and MCP units25/107 | PARTIAL: api_keys has creator provenance only, no subject/ownership contract; no inferred revocation of institutional keys |
| 8 Portability | Fixed Mac paths and repeat slug collisions confirmed | Explicit binaries/PATH, PG16+/Node24+ preflight, installed browser only; unique fixture identities; same-cluster repeat | macOS executed; Linux remains NOT EXECUTED; no Actions enabled |
| 9 Trust/digest | Runtime used separate org env source; raw auth key used for receipts | Runtime shares getOidcBaseConfig; mismatch denies; HKDF domain-separated v2 digests; exact existing v1 receipt and Vault orphan reconciliation | Legacy read-only verification intentionally preserves existing retry identity; auth-key rotation is separate |
| 10 Identity/config | Policy reference query included inactive members; SSO resolution was redundant | Publication rejects inactive references; decisions still check current facts; request-local OIDC config, joined secret metadata and post-Vault recheck | Existing policy retained on suspension; no SCIM/live IdP group revocation claim |
| 11 SSH | Port accepted any valid integer | Default22/explicit validated allowlist, saved host+fingerprint, pinned address; four real loopback SSH tests and port units; safe failure code in audit | No real installation/network probe; no shell bridge |
| 12 Legacy roles | Inventoried reachable routes and server mutation entrypoints | Current org members UI is lifecycle only; project settings has no role editor; legacy membership mutation endpoints return403; policy editor is authoritative | Dead unreferenced legacy components and historical membership rows remain; no grant-by-name restored |
| 13 Secrets | Secret metadata and Vault physical retention are separate | Rotation invalidates test, revoked credential denied before read and rechecked after stalled Vault read before SSH/IdP; failure cannot activate | Physical KV deletion/custody/retention is an operator decision; no destroy executed |
| 14 Memory | Own2GiB typecheck hit V8 heap limit | Own4GiB typecheck and production build passed after host memory/disk preflight | No8GiB run or claim that8GiB is required; no main-vs-PR memory benchmark |

### Finding7 decision still needed

`api_keys.created_by_user_id` records creation, not the principal that owns the
key. The schema has no human/service discriminator or subject binding. Proposed
next contract: explicit key subject kind and subject id, an audited migration
classifying existing keys, then exact human-subject revocation and use-time
membership checks. Do not classify all existing keys as personal or revoke them
by creator: this could disable institutional credentials belonging to another
subject. This decision was escalated, not silently implemented. MCP is still
excluded from the v1 deployment; these synthetic tests do not enable it.

### Finding12 inventory

- `src/app/(org)/[org]/members/page.tsx` renders `OrgMembersScreen`, the
  policy-authorized lifecycle/directory, not a project role editor.
- Project settings render `GeneralSettingsScreen` (name/slug/visibility), not
  project-membership grants. No runtime insert/update/delete of
  `project_memberships` exists in the current non-test source.
- Legacy `SettingsScreen`/`MembersSettingsPanel` in
  `src/features/console/screens.tsx` have no route import/caller; the old mutation
  service rejects with `legacy_membership_unsupported`. They are not presented
  as a working permission editor. Historical project roles remain supplemental
  view constraints, never a substitute for an explicit project policy grant.
- Current access administration is `/[org]/permissions`, including the new
  restricted view-write action. See the before/after analysis in `GESTALT.md`.

## Reservation, migration and recovery contract

Migration0075 (journalidx76,77 migrations total) adds only
`fleet_io_reservations`, scoped by org and operation, with actor FK, keyed input
digest, unique lease, expiry and completion timestamp. No secret or external
response is persisted there. An in-flight duplicate returns409
`operation_in_progress`; expired/uncertain work returns409
`operation_outcome_unknown`. The one exception is a credential save: its Vault
write is idempotent for the same operation digest and value, so after the lease
expires the same operation id may take the reservation over (CAS on the old lease)
and finish. A new operation id skips a KV version orphaned by a lost finalize
(at most 8 slots, revalidating between them); the revision CAS in finalize still
decides which concurrent save wins. No other automatic takeover, and no retry of a
consumed IdP code. Finalization checks the lease both before and after DB work and commits
the receipt/effect/audit together. An operation id cannot cross save/test namespaces.
Short effect transactions still serialize with suspension/policy changes; external
I/O does not retain those locks. A revocation after external I/O began cannot undo
that already started request, but prevents publishing its result.

For an interrupted operation, an operator must correlate the reservation, receipt,
current configuration revision and redacted operation audit before recovery.
An IdP attempt with unknown token-exchange outcome is abandoned; an explicitly
started new login requires a new state/code, not replay of the old callback.
A new read-only SSH test may be requested after reviewing current configuration.
A credential Vault write can exist without DB metadata if finalization fails:
retain the original operation and version for reconciliation, do not blindly use
a new id, reset reservations, delete Vault data or assume rollback of external I/O.
There is no automatic repair UI/job in this patch.

The v2 receipt uses HKDF-SHA256 with a fixed product salt and separate Fleet/SSO
info strings, through Node crypto. New writes only use `v2:`. Exact64hex v1 receipts
are verified read-only using the old canonical payload; neither the row nor its
result is rewritten. Vault CAS0 reconciliation also accepts only the exact legacy
operation digest, scoped ref/version and identical value. Changed input remains
409; no downgrade on arbitrary strings. This explicit narrow transition avoids
duplicating already committed effects when updating the application.

Roll forward0075 before the new application. Back up DB and Vault consistently
under the existing custody plan. No data-down migration/drop is supplied. Do not
roll back to the old lock-based writer while unresolved reservations exist: it
does not understand them. Quiesce affected operations, reconcile outcomes and
choose a reviewed roll-forward or coordinated restore. No remote migration,
restore, Vault destruction or rollout was performed for this review.

## Reproduction commands and evidence boundaries

Set explicit paths only to already installed fixture binaries, or put them on
PATH: `FLEET_TEST_POSTGRES_BIN` (directory, PG16+), `FLEET_TEST_NODE_BIN` (Node24+),
`FLEET_TEST_BROWSER_EXECUTABLE` (Chromium/Chrome). No runner uses the user's default
DB, starts Docker or installs global packages. A missing required binary fails
preflight; Node22 is not reported as supported. Real Vault fixture supports an
explicit `FLEET_TEST_VAULT_BIN`1.21.0; its default verified download is darwin-arm64,
not a claim to have run Linux or a production version recommendation.

```sh
bun tests/review/run-bases-regressions.ts
bun tests/review/run-correction-units.ts
bun tests/fleet/run-postgres.ts --io-review
bun tests/fleet/run-postgres.ts --repeat
bun tests/fleet/run-postgres.ts --browser
# Core authorization's owned-PG runner uses RAVI_AUTH_TEST_PG_BIN (PG bin directory).
bun scripts/test-project-authorization.ts --consumers
NODE_OPTIONS=--max-old-space-size=4096 bun node_modules/typescript/bin/tsc --noEmit
```

Final commit/test evidence is recorded below; no command above implies those
services are installed on the reader's host.
For build use an env allowlist, `RAVI_SELFHOST_BUILD=1`, IA off,
`RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK=true`, a synthetic DATABASE_URL and a
task-owned empty Unix-socket directory. This proves compilation/static generation
without connecting to any installed DB. Measure resources first; run heavy jobs
sequentially. No `NODE_TLS_REJECT_UNAUTHORIZED=0` or global trust change is used.

Own resource limit failures are retained: the2GiB tsc process exited134 (V8 heap);
the first build compiled/typechecked but failed route collection because no
DATABASE_URL was provided. The subsequent synthetic-socket build passed. This
does not resolve or supersede the earlier independent review's provider denial.
Additional test-instrument errors and their corrected runs remain in private logs,
including an SSO UUID/text namespace collision check caught before publication.

Four explicitly owned, stopped PG cluster directories from these tests were
archived to private0600 storage after content verification, then removed to free
disk; no source/evidence from other work was deleted. Logs/screenshots remain.
Archive SHA256 `0baf6e7a4221149e1e6142d783a1f65c63939df79504d3ce0d19ff8397fa0720`.
No fixture database, token, screenshot or raw trace is included in Git.

Three more owned/stopped clusters (uoK4tn, HLkMqd and pfqldU) were subsequently
archived and content-compared before removing only their expanded cluster data.
Their logs remain; second private archive SHA256
`9a85aa02cb437c3d5070c27471b736d25d0ccb32332ce2de890a09523322bdae`.

## Code commits and own validation

Base remains6feb17ed; no history rewritten. These are implementation commits,
not independent-review approvals:

| Commit | Findings / coherent slice |
|---|---|
| e7c754a | 1–2: minimal job principals, provenance, restricted view writes, explicit fixture policies and complete Bases regression runner |
| 67c980e | 5–6/10: bounded content compilation, audit policy, snapshot/batched queries, inactive reference validation, editor check and portable binary discovery |
| f407bb3 | 3–4/8–11/13–14: short I/O reservations/CAS, SSO callback/session/config, HKDF, SSH ports, migration0075 and portable fixtures |
| e7f00c7 | 7: human MCP token revocation/use-time validation, scoped PG proof; repeatable units and full-tree scan runner |

Own acceptance artifacts are local/private; these names are indexes, not included
raw files. All counts below are successful executions, not inferred from build.

| Command / environment | Result | Private evidence suffix |
|---|---|---|
| `bun tests/review/run-bases-regressions.ts`, PG17.10/socket | metrics3 +six221 +job1 +MCP1 =226PASS, no skipped suite | fleet-bases-review-jPkyGB |
| `bun tests/review/run-correction-units.ts`,14 isolated Bun processes | 106PASS/559assertions | fleet-correction-units-tukbUc |
| `bun tests/fleet/run-postgres.ts --io-review` | 7PASS/28assertions; SSH/IdP are barrier doubles, native login/PG real | fleet-pg-test-uoK4tn |
| `bun tests/fleet/run-postgres.ts --repeat` | Fleet5/59 twice on SAME cluster; real local HTTPS IdP/browser in one test; bootstrap1/63, upgrade1/16, org3/27, members5/41, prerequisite1/14 | fleet-pg-test-pfqldU |
| `bun tests/fleet/run-postgres.ts --browser`, final source | full Next/browser/HTTPS/PG/IdP1PASS/91assertions, restart included; preceding Fleet/SSO and ancillary PG suites pass again | fleet-pg-test-blwW7p /fleet-browser-test-I3G6Zs |
| `bun scripts/test-project-authorization.ts --consumers` | core14PASS/169assertions +editor12checks1280/390/keyboard; real PG | fleet-policy-test-6FS9du /fleet-policy-editor-zdAIBA |
| `bun tests/fleet/run-vault.ts --raft` | 14PASS; actual TLS/KV2/Raft/CAS/scope/seal/revoke/redacted audit/quiescent restore | fleet-vault-test-KOh2DF |
| `bun run build`, final code e7f00c7, env allowlist/4GiB | PASS compile +TypeScript +118 static pages, no installed DB | fleet-review-build-release.log |
| ESLint all67 changed/new TS/TSX files; `git diff --check` | PASS, zero lint output | fleet-review-lint-release.log |
| Verified Gitleaks8.30.1, full publishable tree1692 files | raw exit1/17 findings, all exact known path/rule/lineSHA;0 unclassified (not a raw-zero scan) | fleet-candidate-scan-fDHmJ1 |
| Gitleaks git range6feb17ed..e7f00c7 | PASS/0 new-commit findings; full-tree result above remains17 | fleet-review-diffscan.dkFuQ4 |

The Fleet PG and full Next fixtures use synthetic Vault/SSH (the browser fixture
also exercises absent-Vault failure). Real Vault and SSH loopback pass separately;
there is no combined real-IdP+real-Vault+real-remote-SSH E2E claim. Real IdP is a
disposable local oidc-provider, not the client's provider. No native Ravi login,
link or agent bridge was run by this correction package.

The final code build was repeated after the SSO namespace guard and passed; the
separate earlier4GiB tsc also passed. The2GiB failure remains recorded. No Linux
host was available/used, no global package/daemon was installed, and resource
preflights limited heavy work to one fixture/build at a time. No claim of8GiB
required memory or a measured memory regression against main is made.

Final full Next guide screenshots1280/390 were inspected: explicit-permissions
step is visible, optional credential/installation tasks remain optional and
completion does not imply grants or connectivity. The policy editor's separate
keyboard/render result covers the only new action label. Native dev-server
overlays visible in the Next screenshots are not production UI claims.

Unresolved release gates: API key ownership decision above, independent review,
Linux execution, the untouched legacy host/operator/password/capture test
adaptations, production custody/recovery and real-client IdP acceptance. Existing
Page-demo409 and global Ravi authorization/bridge are outside this change.
