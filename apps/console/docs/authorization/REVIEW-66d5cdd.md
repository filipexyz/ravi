# Independent review — R1 candidate66d5cdd

Reviewed product commit `66d5cdd6f80165f90f7dd68fbb08d6d84bcce2f9`, tree
`a958190ce9975884e8c0da34dcca61b7abcf4f49`. Parents: integrated SSE `83f9042`
and original independent reproduction `d7b908a`. Review-only additions contain
no product, migration, policy, deployment or shared-auth changes. Prior review
`a0730ed` and its original failures remain preserved; this is not an amendment
of their evidence.

## Verdict

**R1 PASS in the independently repeated member-lifecycle boundary. Overall
candidate NOT accepted without qualification: new R2 expiration finding is OPEN.**

The Fleet lock closes the demonstrated issuance/suspension resurrection: both
serialization winners, current membership/source-browser checks, rollback and
fresh issuance after reactivation passed on real PostgreSQL. This does not mean
every form of credential revocation or every old writer is covered. It does not
retroactively revoke credentials that escaped before this patch.

R2 is distinct: a valid CLI device code or link request can expire while its
operation waits for Fleet, yet admission after the wait uses an earlier clock
value and produces a durable credential/binding. No missing identity, forged
token, other-org access or provider compromise was demonstrated. The request
starts while its code is still valid and all other admission remains legitimate.

## Independently executed matrix

All commands ran sequentially, with existing dependencies and synthetic private
fixtures, on this exact product commit. No Next/browser/build, package install,
SSH, deployment, push, provider, runtime host or model execution.

| Check | Result | Scope/evidence |
| --- | --- | --- |
| Original R1 + seven related issuance paths | PASS26 tests/131 assertions | Private PG `PWgr0f`; actual `pg_blocking_pids`, both winners, audit rollback, old-token denial and fresh-login success |
| Member administration | PASS5/41 | Same runner, production stores/services |
| Populated upgrade74→75→76 | PASS1/14 | Sentinel preserved, repeat no-op |
| Organization policy | PASS3/27 | Same runner |
| Bootstrap prerequisite | PASS1/14 | Same runner, not a new IdP/browser proof |
| SSE source/session store | PASS8/47 | Private PG `gL6uf6`, migrations76/repeat; deny pending batch after revocation/expiry, pinned A/B scope |
| Auth/Pages/CLI/link units | PASS79/312 | Explicit eight-file set from ADMISSION-RACE; injected protocol/repos where documented |
| Executor/Bases/AI-off/stream-command units | PASS56/196 | Explicit six-file set, not an Executor HTTP deployment |
| R2 expiry-after-lock tests | FAIL2, PASS1;13 assertions | CLI+link fail; Page control passes; reproduced twice in `h8uvbt` and `HipZfR` |
| TypeScript | PASS exit0 | Whole repo before and after new independent test |
| Targeted ESLint/diff-check | PASS exit0 | Candidate changed TS files plus review tests; no baseline suppression |
| Current Next/IdP/browser/build | NOT PROVEN in this window | Prior83f9042 evidence remains historical, not rerun66d5 |
| Expanded host/operator/password/captures tests | NOT PROVEN | Integrator's aborted143 run lacked default-DB fixture; not repeated unsafely |
| Historical escaped credentials revoked | NOT PROVEN; deployment gate | Requires reviewed operator reauthentication/revocation plan |

R1 and R2 DB fixtures use a preverified synthetic OIDC identity. Page policy
allow is explicitly injected to isolate credential lifecycle; it is not a new
project-policy or real-provider proof. R1 and R2 fetch guards record zero forbidden
fetch attempts. The separately executed stream fixture does not dispatch an
agent or command. No member/grant/credential of an actual installation changed.

## R2 — expiration is evaluated before the blocking admission boundary

Relevant product paths:

- `src/server/cli/auth.ts`: `exchangeCliAuth` captures `now` before its
  transaction/Fleet lock, then passes it to `consumeCliDeviceAuthorization`.
- `src/server/cli/device-auth.ts`: the consumption predicate compares
  `expiresAt` with that captured value. It does not re-read the wall clock after
  the lock wait. A conditional single-use update still succeeds exactly once;
  single-use is not the missing property here.
- `src/server/console/ravi-link-requests.ts`: `approveRaviLinkRequest` captures
  `now` before Fleet and request-row locks, then uses it in `checkPendingRequest`.
  Current member/browser checks pass, and binding/request/audit commit atomically,
  but the expired request was admitted using the stale timestamp.

Independent reproduction: `tests/review/issuance-expiry-wait.test.ts` and
`bun tests/review/run-session-race.ts --expiry`.

1. Create fresh synthetic OIDC/browser credentials and an approved CLI device
   code or pending link request using real product functions. Only fixture TTL is
   shortened before starting the operation; no clock mocking or date injection.
2. A separate connection holds the same `fleet:<org>` advisory lock. Start the
   operation while its stored deadline is still in the future.
3. Observe an actual waiting PostgreSQL backend with `pg_blocking_pids`. Keep
   the lock until database `clock_timestamp()` proves the deadline has passed.
4. Release it, await the real service, inspect persisted effects/audits. CLI's
   resulting access token is also accepted by the real `getCliMe` function.
5. Repeat the identical schedule for Page redemption as a differential control:
   it captures its clock inside the locked transaction and returns no session.

Both runs observed, without printing tokens or returned credential objects:

| Surface | Expired before unlock | Observed outcome |
| --- | --- | --- |
| CLI exchange | true | Credential accepted by `getCliMe`;1 session +1 success audit |
| Link approval | true | Active binding;1 binding +1 success audit |
| Page redemption control | true | Denied;0 sessions |

The safe test expectation remains denial and zero durable credential effects.
Consequently the runner exits1; it is **not a passing mitigation test**. No
timeout, thrown configuration error or deadlock counts as a successful denial.
Two-second deadlines are test fixtures; this is not a claim that production
codes have a two-second TTL or that a request already expired on arrival works.

Corrective contract for the auth integrator: validate expiration against a fresh
clock at the serialized admission point, after relevant blocking locks, retaining
single-use predicates, current admission and atomic success audit. Merely using
PostgreSQL `now()` at transaction start can preserve the same stale-clock issue.
Define the admission point explicitly; do not claim atomicity with the eventual
network response. Repeat these expiry checks plus R1 and legitimate fresh issuance.
The reviewer did not implement this correction or alter auth ownership.

## Static checks and boundaries

- Shared lock order is Fleet before policy/membership/credential rows. OIDC
  now resolves current membership in the transaction that inserts session/audit.
  The old check-then-insert window is gone in the observed service paths.
- Page member claim/capture enforce current source browser in OIDC mode. Claim
  redemption consumes and inserts/audits in one transaction. The capture caller
  propagates browser provenance server-side; no client-body authority added.
- Suspension sweeps consumed claims too without destroying their consumption
  metadata. Refresh updates only active rows and never resets status; revoked
  sessions now fail before duplicate-refresh advice. Login/link is not a grant.
- Link creation revalidates the exact current CLI session/user/org/installation;
  approval takes Fleet before request FOR UPDATE and rechecks the real approver.
  Direct binding POST remains closed. R2 does not invalidate these separate checks.
- Operator comments/visibility and connector host resolve the existing member
  session through `verifyPagesSessionForSite`; they do not mint a member session.
  Password challenge writes the separate `pagePasswordSessions` guest surface,
  not an org/browser credential. Its lifecycle is not claimed by R1. Legacy
  connector required-role gates remain a documented limit, not configurable IAM.
- Captures call the corrected session factory but no Chromium/worker/capture
  network execution occurred here. Interface-only fake repository changes in
  the skipped legacy suites are not evidence of functional execution.
- No policy engine, role-name bypass, group ingestion or schema change was added
  by R1. IdP/SCIM immediacy, direct SQL writers, guest/machine lifecycles and
  already-delivered SSE bytes remain outside its guarantee.

## Evidence retention and resource handoff

Private Unix-socket clusters are stopped in runner finally; no TCP listener.
`PWgr0f` retained213MiB; `gL6uf6`54MiB; R2 construction failure `CUpqT5`53MiB;
R2 valid reproductions `h8uvbt`54MiB and `HipZfR`54MiB. No logs/PG/evidence deleted.
Disk measured5.3GiB at start,5.1 after initial regressions,4.9 after the additional
isolated reproductions. No secret env inherited by the runners.

First R2 construction attempt `CUpqT5` exited1 before the intended expiry proof:
the raw postgres-js timestamp binding needed an ISO string after Drizzle parser
configuration, and the Page fixture hostname did not match its stored slug.
Only test construction was corrected; its three failures are preserved and
are neither product findings nor PASS. No expired-admission expectation changed.

Per-file result JSONs stay outside Git with mode0600, under the named private
`fleet-pg-test-review-race-<suffix>` roots. Useful SHA256 identifiers:

- R1 result `PWgr0f`: `fe480ce8a03ac23e52e0d1f2d27884c8c10993ca94a73e632d8275110029d7d5`.
- R2 result `h8uvbt`: `8398392cda25a3b58443a22d7132ea9b3ae7449af005588d77da9f3d41cff2b5`.
- R2 repeat `HipZfR`: `0fb7204a8a6c0b594a3bac3db20681423710a471ef2c9809d8c5f374d969a9b2`.

The existing1669-file secret scan with17 classified fixtures/0 new findings is
integrator-attributed evidence, not a new full scan by this review and not raw
zero alerts. New tests use only generated synthetic users and explicit test-only
secrets. No credentials/results/raw logs are added to Git.

No release-ready, full-task-done, production, global Ravi authorization or
customer IdP claim follows. R2 correction belongs to the same auth integrator;
return the exclusive light-test window with this fixed review handoff. Browser,
build and any future rollout still require their separate resource/authority gates.
