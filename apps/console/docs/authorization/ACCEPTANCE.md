# Local authorization acceptance — partial, not production-ready

The first fixed handoff is coreb4c9e117; its exact contracts are in CORE-HANDOFF.md.
Consumer/UI commit185beb9 is additive; the subsequent closure below retains its
contracts. No deployment or real grant changed.

## Additive membership core after e2c2ef5

Contract and exact adapter signature: MEMBERS-HANDOFF.md. This package adds two
organization actions and a membership-only transactional guard, NOT a directory
endpoint, invitations, combined policy/lifecycle API or joint SSO acceptance.

| Scenario | New evidence |
| --- | --- |
| Fixed twelve bootstrap grants, separate member read/manage, rename/group removal | PASS: engine + membership units13tests/72assertions |
| Bootstrap current catalog adds no members/create/data; replay preserves revoked original grant | PASS: core PG10tests/74assertions, synthetic admission; beforeAll untouched |
| Settings/read-only/manage-only negatives; member manager cannot assign roles via policy HTTP | PASS: membership PG suite, current role grants/revocation; no member DTO/API claim |
| Last effective manager, inactive/deny/role labels, two concurrent removals | PASS: membership PG8tests/54assertions; one removal commits, one rolls back |
| Callback failure/policy mutation rollback; policy writer blocked through effect | PASS: same suite, pg_blocking_pids confirms live lock |
| Existing Pages/Bases/CLI/inbox/creation regressions | PASS: consumer PG13tests/162assertions |
| Member-read policy choice with keyboard, draft/simulate/review/publish; no member-manage implication | PASS: editor browser11scenarios at1280/390, synthetic session, real HTTP/PG |
| Combined onboarding directory/lifecycle/CAS/replay/SSO | PENDING sole integrator; no blanket acceptance of legacy member paths |

Latest stopped private clusters: membership `fleet-policy-test-tNKvAY`, core
`fleet-policy-test-0LLWOl`, consumers `fleet-policy-test-CnZgsz`. Each runner proved
baseline74→own75, sentinel preservation and repeat no-op; joint76 is separate.
Screens `fleet-policy-editor-fCLpDM` organization review1280/390 and completed390
were inspected: choices remain in the organization region, labels wrap, no page
overflow, successful publication hides editing. The bounded action disclosure
scrolls internally; full membership-management label is accessible by keyboard.
No skipped DB tests counted PASS. Earlier suite7/51 and browser10 results remain
historical; the final suites above include the added lock and keyboard checks.
Changed-file lint and diff-check PASS. Full typecheck still fails ONLY at baseline
complete-runtime-config.ts13 (fixed by onboarding, not copied here).
Migration0074 hash remains a698701926b344a63a95f8a858ea642247949ec30e864bc14c87e697d36ae58e.

Run `RAVI_AUTH_TEST_PG_BIN=<postgres-bin> bun scripts/test-project-authorization.ts
--members` for the new isolated suite. Error/audit rollback, member target/CAS/
receipt details and reactivation of preexisting grants are documented in the
handoff; the helper alone is not a complete lifecycle implementation.

| Scenario | State and evidence |
| --- | --- |
| Fixed Casbin, default deny, deny precedence, A/B, human/install/agent lanes | PASS: engine.test.ts11tests/52assertions at core handoff |
| Atomic first grant, concurrent equal/different identity, full rollback/replay | PASS: contract.integration.test.ts9tests/64assertions, real private PostgreSQL; synthetic admitted identity, NOT OIDC |
| Own migration after baseline, upgrade preserves data, repeat no-op | PASS: test-project-authorization runner74→75; joint76-entry sequence belongs to integrator |
| Role UUID/rename/scope, no owner/admin-name power, org read/manage | PASS in core DB tests and real editor; legacy subservice gaps in SURFACES.md remain |
| Draft/CAS/preview/rollback/current revocation/direct HTTP negatives | PASS in real policy DB suites |
| Pages site/Bases/view/rows, A/B, retry, removed write after resolving scope | PASS: consumer PG suite; not live Executor transport |
| Real CLI JWT to decision endpoint and tampered/expired/org/link/install negatives | PASS: consumer PG suite; no Ravi runtime provider installed |
| Inbox filtering before count/pagination, ACK and revocation | PASS: consumer PG suite; inboxv2 client integration pending |
| Base subscription session refresh/explicit renewal | PASS: final consumer run13tests/162assertions; no durable service-principal claim |
| Two humans on one installation, recipient-specific Base events and revocation | PASS: real DB delivery/ACK and watermark tests; recipient-less legacy Base items fail closed, remain stored |
| Concurrent policy-head mutation versus transaction-scoped effect | PASS: real PostgreSQL pg_blocking_pids proves contender waits for authorized effect transaction |
| Role editor at1280/390, save/simulate/review/publish, org role + read-only viewer | PASS: editor-browser.ts10scenarios, synthetic HTTP session; real component/handler/DB, no SSO claim |
| Service unit regression | PASS: final changed-unit set183tests/665assertions across15files; earlier broader240/1439 remains historical. Explicit synthetic policy fixtures, not production identity proof |
| Publisher revocation between object promotion and final persistence | PASS: in-memory publisher suite43tests/170assertions including this new case; no live S3 claim |
| Same-org private Page sharing must not bypass member denial | PASS: CLI unit negatives and real DB denial/regrant |
| Direct artifact ID, version list and artifact count cannot expose B | PASS: real DB read-model regression; not a Next route/browser claim |
| Create + read/write, human/install intersection, atomic default Page rollback | PASS: real DB service path with injected site insert failure; no implicit creator role/grant |
| Project settings mutation/revocation | PASS: explicit project.admin+read and fresh transaction checks; organization-settings branch belongs to integrator |
| Policy manage without read cannot inspect/simulate/self-grant read | PASS: real core DB test; no policy generation change |
| Changed TypeScript/TSX ESLint | PASS; initial synchronous-effect-state error corrected, not suppressed |
| Typecheck | FAIL only baseline complete-runtime-config.ts:13; already fixed in onboarding5c775113, not duplicated here |
| Joint onboarding/SSO/bootstrap/Vault + authorization | PENDING integrator, not blocked by a missing core hash |
| All subservices role-name removal, streams/jobs, creation UI/activation migration | OPEN exact gaps in SURFACES.md; not global compliance |
| Production/staging/provider/bridge/SSH | NOT EXECUTED / out of this local task |

## Reproducibility and limits

### Additive managed-session stream boundary (after42991d54)

- PASS: stream + command unit regression19tests/68assertions. Denied initial
  payload/cursor, revoke-after-load, empty heartbeat denial, already-aborted
  request, cancellation during pending load/auth and listener cleanup covered.
- PASS: `--streams` real private PostgreSQL8tests/47assertions. Current Casbin
  policy publication, same-org A/B, real encrypted event reads, real persisted
  browser-session revoke/expiry, removed membership, canonical project pinning,
  nested-scope change and resolver subject drift. Zero fetch/preconnect attempts;
  two seeded completed commands unchanged, no claimed command or operation.
- The identity admission is synthetic; the session-store functions and policy/DB
  are real. This is NOT a new OIDC provider/login or Next request-context test.
  The real route re-resolves auth/workspace and the preexisting feature gate;
  the sole integrator must exercise that adapter with the combined SSO package.
- Final cluster `fleet-policy-test-QpVJ9e` stopped, migration baseline74→own75,
  sentinel preserved and repeat no-op. Earlier `rdYEVk`8/46 passed before the
  explicit no-fetch guard was added. No schema/migration/shared-auth/nav change.
- Lint and diff-check PASS; typecheck still reports only the same baseline
  complete-runtime-config.ts13. No production build or runtime activation.
- This check is per batch, not a network transaction. Already queued bytes cannot
  be recalled and a revocation after the last observation may race that batch.
  No claim about other streams, background execution or instant revocation.

Run `RAVI_AUTH_TEST_PG_BIN=<postgres-bin> bun scripts/test-project-authorization.ts
--streams`. See STREAM-HANDOFF.md for the exact wiring and integration limits.

Use Bun frozen lockfile. Engine/unit tests need no database/provider. The PG runner
requires an explicit PostgreSQL binary directory and creates its own Unix-socket
cluster with no TCP listener, synthetic data and a finally-stop. Run `--contract`
for the partial core, `--consumers` for service/browser tests. Browser uses isolated
Chrome/profile and aborts outside-origin requests; it does not open the operator's
session or access a remote installation. Runtime evidence is retained outside Git.

Latest consumer: `fleet-policy-test-4CBXDJ` stopped, browser
`fleet-policy-editor-di5qUU`;13tests/162assertions,10browser scenarios. Core cluster
`fleet-policy-test-CQziZB` stopped,9tests/64assertions. Settings+engine units17/59
also passed after the additive closure. The preceding
`fleet-policy-editor-Hp7b6A` desktop/mobile screenshots were visually inspected:
scope/role grouping, legible labels, no overflow; final copy then clarified that
publication applies to organization AND project decisions. Original grouping and
closure remain; the expanded review is deliberately long and may be collapsed.
Final di5qUU390 organization review and1280 published screenshots were inspected:
the new create action wraps without overflow, separate-data-grant wording is
visible, and successful publication collapses edit/review controls.
Earlier failures remain in thread/evidence. No skipped DB test is counted PASS.

## Integration / activation / rollback

Only onboarding integrates shared files; use fixed commits, no dirty-tree copying.
Apply0073 then0074, never edit prior SQL hashes. Seed no production role-name allow.
Current empty-org bootstrap yields explicit organization configuration authority
and ZERO project data; policy publication is needed for projects/installation
ceilings. Existing-member migration remains a deployment blocker. Policy rollback
is a new draft+review+publication, not history deletion or binary downgrade to
role bypasses. Keep AI off. No destructive down migration is supplied.
