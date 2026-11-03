# Independent integrated-candidate review: e501e5d

Candidate: `e501e5d3909644e4238105f83cdf133dbbabc8a7`, tree
`13039cedf353e24da8527d790bbc1c53a7516a7a`. Review worktree is detached and
separate from the sole integration owner. No product source changed in this
review. Added files are a local regression reproduction and this report.

## R1 — session issuance races membership revocation (high priority)

**Confirmed, not fixed.** `src/lib/auth/oidc-store.ts:47` reads active membership
before opening the session-insert transaction at line52. Membership suspension
revokes rows visible to `src/server/console/fleet/members.ts:82`, but does not
serialize with this pending issuance. A later insert escapes the sweep.

Observed ordering, using actual production store/service functions and private
PostgreSQL17, on two independently initialized clusters:

1. A synthetic, already verified identity passes the active membership check.
2. A fixture-only BEFORE INSERT trigger pauses its session insertion. A separate
   connection holds the test advisory lock; `pg_blocking_pids` proves the wait.
3. The real member service commits suspension and its session revocation.
4. Releasing the test gate allows session creation with `revoked_at IS NULL`.
5. Session read correctly returns null while the member is suspended.
6. The real member service reactivates the member. The **same session** is now
   accepted without another login. The security expectation remains red.

This is a lost revocation, not a demonstrated ability to act while suspended.
It contradicts the lifecycle promise that reactivation does not revive prior
admission. The test does not contact an IdP, forge a live identity, connect to an
existing database or create a production credential. Tokens stay in process;
output contains only booleans and synthetic identity fields from the failing
assertion. The test-only trigger is never proposed for the product.

Reproduce: `bun tests/review/run-session-race.ts`. Runner sanitizes inherited
environment, creates a private Unix-socket cluster with TCP disabled, and stops
that cluster in finally. Both runs: exit1, 0PASS/1FAIL, five assertions; the final
`expect(resurrected).toBeNull()` is the failure. Evidence roots:

- `fleet-pg-test-review-race-QLiN4Y`
- `fleet-pg-test-review-race-sFRp2C`

Recommended invariant for the auth integrator: current admission validation,
issuance and member deactivation must share a serialization boundary, in the
documented lock order. If issuance wins, suspension must revoke it; if suspension
wins, issuance must reject. A final recheck outside that boundary is insufficient.
Review analogous CLI/Pages/link issuers too; those paths have **not** been
reproduced by this finding. No auth/shared-file patch was applied here.

The existing reproduction intentionally forces the vulnerable ordering. A fix
using shared locks may prevent step3 from committing until the gate is released:
adapt the scheduling harness to that legitimate ordering, but retain the final
no-resurrection requirement and tests for both possible winners. A timeout alone
is not proof of a fix.

## Independent positive regressions

Executed against the candidate, not merely copied from the integrator's report:

| Test | Result and scope |
| --- | --- |
| `bun tests/fleet/run-postgres.ts --browser` | PASS: 17 tests/296 assertions across seven files; isolated real PG and migrations, real local IdP/Next/browser for covered flows |
| Fleet core/SSO candidate | 5/46; Vault synthetic in this suite, not a new real-Vault acceptance |
| First owner/bootstrap | 1/63; protected first identity with explicit grants |
| Populated upgrade and repeat | 1/14; 74→75→76 and repeat no-op |
| Organization authorization | 3/27 |
| Member lifecycle | 5/41; CAS/replay, rollback and already-existing session revocation; does not cover R1 |
| Bootstrap prerequisites | 1/14 |
| Real Next/browser | 1/91; initial login, read/manage, creation policy, API negatives, restart persistence |
| HTTP contract | 8/52; `bun test tests/fleet/http-contract.test.ts` |
| Candidate typecheck | PASS, exit0 before adding the reproduction |

PG runner evidence root: `fleet-pg-test-ViO6Q1`, stopped. Browser evidence root:
`/tmp/fleet-browser-test-MthYQV`. Inspected actual `members-1280.png` and
`members-confirmation-390.png`: grouped identity/status/actions, explicit
confirmation and keyboard focus, legible wrapping without horizontal overflow.
No claim of full accessibility audit. Next regenerated next-env.d.ts to its dev
path during the test; that test-owned change was restored via apply_patch only.

## Boundaries

SSE commit5e41ec52 is absent from this candidate. Its composition and real browser
proof belong to the integrator's separate new candidate, not these results.
No production/staging/SSH/deploy/push, real Ravi provider delegation, live
Executor transport, external IdP or real credential custody tested here. The
earlier documented legacy-surface and migration/activation gaps remain.
Candidate is **not approved for release** while R1 remains open.
