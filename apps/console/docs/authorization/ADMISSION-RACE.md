# R1 — issuance and membership lifecycle

Local corrective candidate on top of SSE `83f9042`, composing the independent
reproduction `d7b908a`. Exact final commit/tree are in the handoff. No deployment,
remote login, actual provider or grant change. R1 was reproduced against e501
twice; that report and Git commit remain unchanged. This document supersedes any
blanket no-resurrection statement for e501, not its unrelated historical tests.

## Serialization contract and inventory

`src/lib/auth/member-issuance.ts` uses the SAME PostgreSQL advisory transaction
key `fleet:<org>` as the member lifecycle, before any policy/row locks. Callers
read current user/org/membership/source credentials inside the issuance transaction.
No second permission engine, implicit role grants, schema or migration added.

| Credential / entrypoint | Boundary implemented or verified |
| --- | --- |
| Console OIDC `createOidcBrowserSession` | Fleet lock → current issuer/subject/member lookup → session + success audit in one transaction. Provider exchange stays outside this DB transaction. |
| First-owner bootstrap | Existing `noMembers` takes Fleet and creates first identity/member/session + grants/audit atomically; code unchanged. Prior real-login proof is historical, not rerun here. |
| Page member claim | Current membership and, for OIDC, source browser session checked inside Fleet transaction; claim + audit atomic. Guest claims remain a separate server-validated access-grant path. |
| Page claim redemption | Initial read only selects org lock key; guarded consumption, matching claim identity/site/host, session and both audits use the same transaction. Lifecycle also marks consumed claims revoked, retaining consumedAt/request metadata. |
| Page capture session | Current membership and OIDC browser source checked under Fleet, session + audit atomic; capture worker is NOT run in this suite. Non-browser callers still rely on their existing server authorization plus current membership. |
| CLI device approval | Rechecks current membership/browser source and code state under Fleet; same-actor approved replay only after admission; approval + audit atomic. Public unbound pending code alone carries no authorization. |
| CLI human exchange | Fleet before consumption/installation/session writes, current membership checked again; device code single-use status checked in the same transaction. Legacy external-provider path is not exercised. |
| CLI refresh/logout | Refresh UPDATE is conditional on exact hash and active status; never reactivates a row. Current session validity now precedes duplicate-refresh grace; revoked is terminal, not409 retry advice. Logout is monotonic revocation. |
| Ravi link request | Fleet + current exact CLI session/user/org/installation + membership before creating pending request and audit. Direct binding POST remains closed. |
| Ravi binding approval | Preliminary request read only selects Fleet key; then lock Fleet, lock/re-read request, revalidate current member/browser and verified-email constraints, binding + consume request + audit atomically. |
| Installation-subject CLI credentials | No human/membership; separate installation lifecycle, unchanged and not claimed covered by member suspension. |

The seven related paths in the regression are Page claim/session/capture, device
approval, CLI exchange, link request/binding, in addition to the original OIDC
issuer. All use production stores/services and private PostgreSQL. The trusted
OIDC session ID is propagated only server-side; it is not accepted from a body
as identity or a permission. No name-based owner/admin bypass was added.

## New local evidence

`bun tests/review/run-session-race.ts --regressions` is a bounded private Unix
socket PG runner, no TCP, inherited secrets or browser. Each run shuts its cluster
down in finally. Per-file results from the final regression runs are retained
privately beside that cluster, not copied into Git. Fixture values are synthetic.

- R1 regression: **26 tests /131 assertions PASS**, including both observed
  serializations of OIDC and seven related issuers, rollback on audit failure,
  refresh racing suspension, stale token/source denial after reactivation and
  fresh login/device approval/Pages/link success. Final cluster `fleet-pg-test-review-race-3jydri`
  repeats the26/131 proof from `Nz22YB` after final repository guards/audit preservation.
- Same run: members5/41, populated upgrade1/14, organization policy3/27 and
  bootstrap prerequisites1/14 PASS. Cluster stopped. Earlier25/124 result in
  `PxzzYQ` and repeated25/124 + regressions in `QFDsby` are checkpoints, not the
  final fresh-login test.
- Auth/Pages/CLI/link units79/312 PASS: actual logic with signed protocol fixtures
  and in-memory repositories where explicitly injected, not HTTP/browser E2E.
- SSE source with real PG/session store8/47 PASS (`fleet-policy-test-jGDqmv`),
  migrations76 + repeat no-op and sentinel preserved; cluster stopped. This
  is the source/stream factory, NOT a new Next/request/browser execution.
- Executor/Bases/IAoff/stream-command units56/196 PASS in a separate completed
  process. No model/runtime or gateway transport execution.
- Whole-repo TypeScript `bun run typecheck` PASS after final source changes;
  targeted ESLint and `git diff --check` PASS. No production build was run in
  this resource-bounded correction window.
- R1 tests replace fetch with a refusal and assert **0 forbidden fetch attempts**.
  No provider, agent, runtime host, capture worker or installation executes.

The concurrency tests use fixture-only triggers plus separate connections and
`pg_blocking_pids`, not timing guesses. The old schedule expected suspension to
overtake the insert; the fixed schedule proves it waits when issuance owns Fleet.
The reverse schedule proves waiting issuance denies after suspension. Test
timeouts, deadlocks and503 configuration failures propagate, never count as a
successful denial. Tokens remain in process; results contain counts/booleans.

OIDC identities in these DB tests are pre-verified synthetic objects. They prove
the store's admission boundary, NOT a fresh IdP/browser callback. Project access
for the Page claim fixture is an explicit synthetic allow to isolate lifecycle;
it is NOT a new project-policy acceptance. The real Next/SSO/SSE/browser proof
belongs to83f9042 and has NOT been rerun after this fix (resource gate). Build and
full managed IdP/Vault topology likewise remain separate. Independent reviewer
must validate the fixed candidate before R1 is called independently accepted.

## Preserved failures

- Original e501 reproduction: `QLiN4Y` and `sFRp2C`, FAIL by same-token revival,
  preserved atd7b908a. No test expectation was changed to accept the vulnerability.
- `vu796q`: expanded harness lacked Pages session-secret fixture;503 and unobserved
  INSERT barriers failed4 tests. Fixture corrected; unexpected errors explicitly
  cannot count as a denial. `Frze8X` then passed17/103.
- `tMx3Bm`:24PASS/1FAIL because revoked CLI's previous refresh token returned409
  AUTH_PENDING before active-state check. Product order corrected; no credential
  was issued by that failure, and subsequent strict401/403 tests passed.
- Typecheck found missing PageCaptureWorkspace provenance field; added to the
  server-only type, no suppression. Subsequent typecheck passed.
- `fleet-policy-test-D2YhhX`: sanitized environment omitted actual USER/LOGNAME;
  Bun userInfo resolved `unknown`, unlike initdb OS user. Failed before migrations,
  cluster stopped. This is not a stream-product failure or a PASS.
- Expanded legacy host/operator/password/captures unit invocation: incomplete
  fixture assumptions caused policy lookup of the absent default localhost55432
  database (ECONNREFUSED). Only that owned runner was terminated (exit143);
  no listener/database was started. Its partial assertions are NOT counted as
  a suite PASS. Those fixtures need explicit policy dependencies/private DB
  preparation; not fixed by weakening product enforcement or by this R1 patch.
  Their interface-only test-double additions are not a claim of execution.

## Deployment and limitations

Do not roll back to e501 or83f9042 as if they contain R1. No schema migration is
needed for the code change. Historical escaped credentials are not retroactively
identified by this patch: an operator-reviewed revocation/re-authentication plan
is required before rollout if an installation ran the vulnerable lifecycle.
No bulk revocation, data deletion or live deployment was executed here.
The org-wide Fleet lock deliberately serializes admission with administration;
load/latency limits have not been benchmarked by these local functional tests.

The boundary covers the supported member lifecycle service; direct SQL, unrelated
legacy identity synchronizers or future writers must honor the same protocol.
It is not a promise of instant IdP/SCIM/group revocation or recall of already
returned data. Guest grants and installation credentials keep their own lifecycles.
Original Page409, real Vault custody, existing-org policy activation, customer IdP,
bridge/runtime delegation and production/HA/DR gates remain unchanged.

## Reproduction commands

```sh
bun tests/review/run-session-race.ts --regressions
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin USER=luis LOGNAME=luis LANG=en_US.UTF-8 RAVI_AUTH_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bun scripts/test-project-authorization.ts --streams
bun test src/lib/auth/oidc.test.ts src/server/console/workspace.test.ts src/server/console/ravi-control-workspace.test.ts src/server/console/pages/auth.test.ts src/server/console/pages/auth-start.test.ts src/server/cli/device-auth.test.ts src/server/console/ravi-link.test.ts src/server/console/ravi-link-requests.test.ts
bun test src/server/console/executor/protocol.test.ts src/server/console/bases/access.test.ts src/server/console/bases/idempotency.test.ts src/server/console/pages/chat/engine.test.ts src/server/console/managed-runtime-event-stream.test.ts src/server/console/managed-runtime-commands.test.ts
bun run typecheck
```

For the existing stream runner, USER/LOGNAME must match the actual local OS user
(`id -un`), not a fabricated account; the example above matches this workstation.
Never inherit an existing DATABASE_URL, secret env or production credentials.
Run sequentially with disk margin; do not run the browser/IdP full runner under
the PG-only resource gate. Original FAIL can be reproduced at the fixed d7b908a
commit in its own checkout, not by reverting this candidate in place.
