# R2 — expiration at serialized admission

Local corrective candidate based on review-only `57ca2f5`, parent `66d5cdd`.
The independent [review](REVIEW-66d5cdd.md) remains unchanged: R1 passed within
its member-lifecycle boundary; R2 was reproduced twice and remained open. This
candidate still requires independent review. No deployment or live revocation.

## Contract

The final admission checkpoint is **inside the transaction, after effect and
success-audit writes and before returning from the transaction callback**. The
source must still be valid against a fresh wall clock at that checkpoint. This
also covers a later row/unique-key/write/audit wait after the preliminary check.
An expired source throws and rolls back consumption, credentials/bindings, and
success audit together. Attempt/denial audit is not success. Equality is expired.

Fleet remains the first lock, before credential rows and policy/membership locks.
Source rows are locked before preliminary expiry checks where consumed/mutated.
Neither a Date captured before waiting nor PostgreSQL transaction-start `now()`
is a valid post-wait clock. The clock is not frozen across awaits. No assertion
of atomicity with the later commit/network response or immunity to host clock
skew is made. Local tests share one OS clock and compare actual DB wall time.

| Surface | Change / boundary |
| --- | --- |
| CLI device approval | Fleet → device row FOR UPDATE → current browser/member and code; final browser/code deadline after audit; same-actor replay still requires valid sources. |
| CLI device exchange | Consumption acquires source row and returns its deadline/admission time; final deadline after installation/session/audits rolls all effects back on expiry. |
| User CLI refresh | Fleet → session row → re-read current records/hash/status/expiry; rotation, installation touch and success audit are one transaction; final check uses OLD source deadline, never the extended deadline. Concurrent duplicate remains retry/denial, not second issuance. |
| Page claim redemption | Fleet → claim row FOR UPDATE → fresh deadline; final check after session and both audits. Internal rollback signal is mapped to the existing null refusal only outside the transaction. |
| Page claim / capture issuance | Source browser is rechecked after writes/audit. No member-session use from a stale browser snapshot. |
| Ravi link creation | Existing pending-request row wait precedes live caller validation; final CLI source check undoes rotation/creation/audit if caller expires during later writes. |
| Ravi link approval | Fresh clock after Fleet/request-row lock; final approver/browser and request deadline after binding/request/audits; expiry throws to undo binding reactivation too. |
| First-owner bootstrap | Same owner/auth module: grant row locked after existing Fleet/no-members guard; grant AND attempt rechecked after OIDC exchange/effects/policy/audit. Expiry rolls back owner, session, grants, receipt and consumption. Begin also rechecks grant after its driver/write. TTL calculations use clock_timestamp, not transaction-start time. Initial12 explicit actions unchanged. |
| Normal OIDC browser issuance | R1 boundary unchanged. Provider validates identity before DB admission; no expiring stored code is consumed here. Session TTL computed before Fleet cannot extend validity while waiting. No claim of a new real IdP callback test. |

No role-name power, new policy engine, identity spoofing, schema or migration.
Link's existing optional clock injection is only an internal unit-test seam;
HTTP handlers do not accept a clock from the body. The actual PG expiry suites
use real clocks, not that seam. Installation/machine credentials, guest grants
and unrelated legacy synchronizers retain their separate lifecycle boundaries.

## Local evidence and preserved failures

Private Unix-socket PostgreSQL, sanitized env, no TCP/default DB, no browser,
provider, agent or host operation. Each runner stops its cluster in finally.
Per-file results and failed runs remain in private temporary directories, not Git.
Assertions reject unexpected errors/deadlocks/timeouts/config503; they never count
as successful denial. Test TTL2s is synthetic, not a change to production TTL.

| Check | Result / retained evidence |
| --- | --- |
| Independent R2 original | FAIL2/PASS1 at66d5, twice: h8uvbt/HipZfR, retained by reviewer. |
| Corrected original three cases | PASS3/15, `fleet-pg-test-review-race-eOprGe`. |
| Expanded expiry | PASS25/137, `fleet-pg-test-review-race-skpjxx`: Fleet/source-row/audit waits; unchanged sources/effects on rollback; browser/caller expiry; single-use concurrent positives and replay; valid device repeat then expired denial. Earlier20/105 checkpoint CjlaAk preserved. |
| Bootstrap extra reproduction | FAIL2/PASS1, `fleet-pg-test-review-race-n3VCDy`: before bootstrap patch, grant or attempt expires during final audit wait yet owner/session/policy persist. No live IdP involved. |
| Corrected bootstrap boundary | PASS3/16, `fleet-pg-test-review-race-uGfYYd`: both deadlines roll back all effects; fresh valid completion and replay denial preserved. |
| R1 regression | PASS26/131, `fleet-pg-test-review-race-7yuiom`: both issuance/suspension orders, source revocation, audit rollback, fresh issuance after reactivation, refresh versus suspension. |
| Same regression runner | members5/41, populated upgrade1/14, org policy3/27, bootstrap prerequisites1/14 PASS; migrations and data preserved. |
| Auth/Pages/CLI/link units | PASS79/312, explicit8-file set, injected repositories/signed protocol fixtures; includes exact link deadline equality. |
| Executor/Bases/AI-off/stream-command units | PASS56/196, explicit6-file set, no gateway/runtime/provider execution. |
| SSE source/session regression | PASS8/47, `fleet-policy-test-DtwtBY`; migrations76, sentinel and repeat no-op; no runtime execution. |
| TypeScript / targeted ESLint / diff check | PASS exit0 on final source/test edits; existing dependencies, no build or suppression. |

The bootstrap extension uses a generated operator-grant fixture and synthetic
verified identity driver, but real service, encrypted state cookie, PostgreSQL,
policy initializer and audit. It is NOT operator delivery, live custody or a real
OIDC login acceptance. Member Page policy allow is explicitly injected to isolate
credential lifecycle, not an additional project-policy proof. Both new PG suites
assert zero forbidden fetch attempts. No fixture credentials are published.

An intermediate typecheck failed on generic inference for the heterogeneous test
callbacks; explicit `unknown` at that harness boundary fixes typing only, without
weakening denial/effect assertions. The earlier R1 expanded host/operator/password/
captures invocation remains incomplete/exit143 due to missing default-DB fixtures;
its interface-only changes are NOT execution evidence. No such unsafe suite was
retried in this window. Original R1/R2 review files and assertions are preserved.

Result SHA256 identifiers (private raw results remain outside Git):

- Expanded expiry skpjxx: `365298971dfbb96ea85085a8085557a010a26f40700f50261823fbbea0d536a5`.
- Bootstrap FAIL n3VCDy: `b632900b0363a3d34b9b9f3c0c3ce76891ccd863d06496190ae5bea88770878a`.
- Bootstrap PASS uGfYYd: `fa5ed2273076b21776a2b300b1c858d127dc2965353fe9c829d725cb30113148`.
- R1 PASS7yuiom: `121f66a32ad12e60f2f4e3734896dcdac45f112349b9ca500c16cb78ef7d0634`.

All seven clusters stopped; retained sizes53–54MiB each except the combined
regression7yuiom213MiB. Available disk4.9GiB initially,4.5GiB after these runs;
no cache/data/evidence cleanup in this window. Scan and fixed hash/tree are in
the handoff after final snapshot verification. Do not inherit build/Next/browser
PASS from83f9042. Legacy adapter fixtures remain NOT PROVEN.

## Reproduce (one load at a time)

```sh
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin LANG=en_US.UTF-8 bun tests/review/run-session-race.ts --expiry
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin LANG=en_US.UTF-8 bun tests/review/run-session-race.ts --expiry-bootstrap
env -i PATH=/opt/homebrew/bin:/usr/bin:/bin LANG=en_US.UTF-8 bun tests/review/run-session-race.ts --regressions
```

The existing [R1 commands](ADMISSION-RACE.md#reproduction-commands) identify the
pure unit and stream sets. Verify space and resource ownership first. Do not run
Next/build/browser/download or the full real-IdP fixture in the light-test window.

## Handoff / operational gate

No data reset, secret read, historical credential revocation or staging changes.
Already-escaped R1/R2 credentials cannot be retroactively identified or repaired
by this code patch. The operator must review a scoped reauthentication/revocation
plan before deployment; deployment belongs to its existing remote owner. Do not
advertise rollback to66d5/83f9042/e501 as containing this correction.

Independent review on the next fixed hash, post-fix Next/build/browser and safely
isolated legacy fixtures remain gates. Vault custody, customer IdP, existing-org
policy activation and production/HA/DR are unchanged external gates. No bridge,
global Ravi runtime authorization or Console AI engine was activated.
