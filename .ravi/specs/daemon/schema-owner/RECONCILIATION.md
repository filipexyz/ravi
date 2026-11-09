# Disposition of the deferred #769 serialization candidate

This records the disposition of `/tmp/ravi-769-deferred-schema/serialization-only.patch`; the temporary files are not an unapplied prerequisite for #817. The candidate was excluded from #769 at `1aa39c651e4e1028ae46d25dda5e8f8002e2abde`. Its report explicitly says it was never tested. Textual apply checks and a design review are not execution evidence.

All 18 base/proposed file versions were checked against the manifest's SHA-256 and available Git blob hashes. Patch SHA-256: `5eb3fe406ff35b7c357457481dfd61c55cbcaf0227561378f3f18c974d53681b`. Manifest SHA-256: `28f5c45c4a0005c7f9e0697cec4df939d297e465207f634c3f4d510825ff52b2`.

## One exclusion protocol

The accepted protocol is kernel ownership for the daemon's lifetime, plus reentrant per-database kernel locks for complete initialization sequences. Commit `7f1be07f2bdaf11092677576b7475fe8235b4e50` introduces the lock and handoff; `59d36e9222efc76bdbefafff108c3124754b3edd` integrates initialization and journal setup. Migration callbacks keep their existing transaction/FK boundaries.

The candidate's two-phase IMMEDIATE/savepoint protocol is **not applied**. It deliberately moves FK suspension before BEGIN for selected parent-table rebuilds, so it should not be described as the previously rejected FK-inside-transaction no-op. It is nevertheless an alternative with a different rollback contract, requiring migration extraction and transaction rewrites. It does not by itself exclude an old daemon's later lazy DDL or gate a replacement before database opens. Layering it over lifetime ownership is unnecessary for this fix and would establish two overlapping coordination protocols.

In #817, callback failure preserves the original error and leaves readiness absent after successful invalidation. Existing migration-owned transactions determine which schema/data writes roll back. A callback that commits partial changes is not promised automatic rollback: the tested recovery path is absent readiness followed by explicit repair. SQLite I/O/commit failures retain their own semantics.

## Candidate disposition by file

| Candidate change | Disposition in #817 |
| --- | --- |
| `src/db/schema-owner.ts`: phase-level IMMEDIATE transaction, inner savepoint, optional FK-off preparation | Rejected as the alternative protocol described above. Equivalent exclusion/invalidation/publication ordering is implemented under `withSchemaMigrationLock`; whole-callback rollback is intentionally not equivalent. |
| `src/router/router-db.ts`: extract routes/contexts parent rebuilds; replace explicit receipt/trigger transactions with nesting-safe transactions | Not applied. Existing rebuild ordering, FK suspension and migration-owned BEGIN/COMMIT remain intact under the external kernel lock. |
| `src/channels/outbound-publish-outbox.ts`: replace explicit transaction with a nesting-safe wrapper | Not applied; no outer SQL transaction is introduced, so nesting conversion is unnecessary. Existing outbox regression suite passed locally. |
| `src/credentials/store.ts`: move backend rebuild to preparation; relocate FK suspension | Not applied. Existing rebuild owns its transaction and disables FKs outside it. #817's real concurrent credential migration test checks scope/audit references and foreign-key integrity. |
| `src/db/schema-owner.test.ts`: remove the synchronous two-connection test | Not applied. Existing coverage remains, supplemented by independent-process tests. |
| New `src/db/schema-owner-concurrency.test.ts`: process interleavings and preparation/savepoint rollback | Shared exclusion/failure/retry requirements are covered in `schema-lock.test.ts` and its process fixture. Preparation interleavings and automatic callback rollback tests are not imported because that API/contract is rejected. |
| `src/router/router-db.contexts.test.ts`, `src/router/router-db.trigger-session-check.test.ts`, `src/credentials/file-backend.test.ts`: tests for extracted preparation/nested transactions | Not copied as proof of a migration rewrite that is not being made. Existing domain tests remain; the accepted FK and concurrency regressions are documented in CHECKS.md. The candidate tests remain unexecuted and are not counted as passing. |

## Journal-mode coverage is complementary

The preserved patch changes **no production `journal_mode` opener**. Its only WAL setup addition is in the new test fixture. #817's nine opener changes are independent, already committed in `59d36e9222efc76bdbefafff108c3124754b3edd`, and use `configureStateJournalMode`:

- `src/router/router-db.ts`
- `src/db.ts`
- `src/contacts.ts`
- `src/credentials/store.ts`
- `src/insights/insight-db.ts`
- `src/knowledge/store/db.ts`
- `src/devin/store.ts`
- `src/bridge/store.ts`
- `src/sdk/return-schemas/workflow.ts`

The helper skips consumers and uses the same database kernel lock as initialization. This closes the observed race during WAL setup before the initializer callback. It does not globally disable foreign keys.

The comparison also exposed an opener failure-path defect in chat, router and Devin: a handle could be cached before journal setup, and remain cached if acquiring the schema lock failed. The #817 follow-up removes failed handles from that path and requires the next call to repeat setup. This is an additional correction in #817, not a fix present in the deferred candidate.

## Integration order and retained #769 fixes

#817 was stacked on #769. `fix/dev-state-boundary` was only a temporary comparison/test base and **must not receive a merge from #817**. #769 landed as `9e87922815b98dcf1d9a283c6968b4ad42fa379a`, followed by #816 as `31150f77815f46236faa5afe8d3eb88fb734bec4`; this history also contains #815 / `bb681d60`. The final integration uses one history-preserving merge of that `dev` into #817, followed by retarget to `dev`. Publication must remain non-forced. Green Quality Gate and independent review must apply to the resulting final head, not a previously tested stacked head. The landing owns the eventual squash decision.

The candidate's base already includes another #769 worker's consumer-first validation: assert readiness and return before consulting the owner cache. That is not a serialization-patch change. It is present in final `dev` and retained in the combined initializer: consumer validation returns before the owner-only lock/cache path, and the owner cache is written only after successful initialization. Final-head validation and independent review remain required; this is not evidence that the rejected transaction candidate was absorbed.

The integration also retains #769's pre-move legacy-source/WAL/SHM validation, prepared-statement cache validation, cloud/lazy-store ownership and remaining restrictive fixes, plus the #815 runtime tables. The nine opener changes against final `dev` have the same stable Git patch ID (`f067df616281b4ac03340402a00b75dda4b40d8b`) as their original #817 delta. The schema-owner tests retain final `dev` in full and add #817's journal-configuration case plus explicit stale-readiness regressions after successful consumer calls, with and without a cached owner. No rejected transaction/preparation API is reintroduced by conflict resolution.
