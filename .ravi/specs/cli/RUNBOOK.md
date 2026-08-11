# Global CLI Contract / RUNBOOK

Terms and transport names follow the normative definitions in
[`SPEC.md`](./SPEC.md).

## Diagnose a contract regression

1. Reproduce through the real surface that failed. Record command/body,
   runtime-context presence, stdout, stderr, status and side-effect evidence.
2. Identify the stage: authorization, input parsing, entity resolution,
   confirmation, handler, transport adapter or audit.
3. Reproduce the same semantic invocation through process CLI, exported tool
   and gateway when the command is public on those surfaces.
4. If an envelope is followed by `Error:`, inspect generic catches. A
   `ContractError` must remain structured and be rendered once.
5. If a gateway returns 500, verify its body is a redacted canonical
   `UNHANDLED_ERROR` or `RETURN_SHAPE_ERROR` envelope. Any other known
   `ContractError` must be translated before the unexpected-error path and
   retain its own non-500 status mapping.
6. In remote mode, verify the target gateway performs authorization. Reject a
   response as non-canonical if `success`, `op`, `exitCode`, `outcome` and the
   error shape are incomplete or incoherent; never trust or print its raw body.
7. If an operation is denied/allowed unexpectedly, inspect the implementation
   effect before changing `CommandAccess.kind`; then scan live capability
   consumers and templates.
8. If exit `3` appears, verify the effect against the
   [risk-based confirmation policy](./SPEC.md#risk-based-confirmation-policy).
   Confirm that every side-effect-free validation/not-found check ran first and
   use spies to prove the plan caused no effect. If a lookup initializes
   storage, require the plan to identify deferred resolution and keep it
   behind `--execute`.
9. If a smoke breaks after adding a brake, update the consumer only when the
   classification is correct. Otherwise remove the brake; do not teach callers
   to confirm low-risk routine work.
10. For a redaction failure, inspect the parser message, plan, suggestion,
    transport body and audit independently. Assert absence of the sentinel,
    not merely presence of a mask.
11. Compare local and CI failures by test name and platform. A changed shared
   dependency can regress an unchanged test file.

## Pre-merge sequence

1. Run every [focused validation group](./CHECKS.md#focused-validation).
2. Run the pull-request workflow from
   [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) on the same
   head.
3. Inspect the workflow log and verify that each focused test was selected,
   either by the repository test script or by a dedicated CI step.

Run these gates in Linux CI. Local evidence from another platform may support
diagnosis, but it does not replace the pull-request workflow on the same
commit. `bun run test` does not count as evidence for a test it did not run.

Review the diff after the gates:

- root spec contains global rules; domain specs contain only local facts;
- product specs changed only when behavior or an executable example changed;
- skill growth is justified by domain doctrine, not copied `--help` output;
- every braked consumer has `--execute`, and immediate operations do not retain
  obsolete confirmation flags;
- ledger claims match current tests and CI evidence;
- each coherent correction has its own commit.

Only after those checks are green for the current head:

1. change [`SPEC.md`](./SPEC.md) from `draft` to `active`;
2. update [`MIGRACAO-LEDGER.md`](../../../MIGRACAO-LEDGER.md) with the exact CI
   run and observed failures;
3. request final review and issue `APPROVE` or `DO NOT APPROVE`;
4. do not merge automatically.
