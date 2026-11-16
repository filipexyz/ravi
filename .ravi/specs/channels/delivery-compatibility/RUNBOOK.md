# Delivery compatibility operations

This PR has no runtime activation command. Do not restart or migrate to test it.
Run only the focused isolated tests in CHECKS.md. The future migration must
install the floor before recovery can acquire a compatibility permit.

When integrating, provide the controller's complete current launch inventory,
state/domain and epoch. Inspect every consumer relation; one unsupported or
unknown consumer blocks the entire cohort. Do not replace missing evidence with
health, PM2 status, Threads readiness, claim expiry or a hand-edited boot file.

The process observer supports Linux procfs and macOS kernel process information.
Unknown OS layouts or ambiguous launch commands fail closed. Replacing a bundle
requires a new controlled boot and new permit. An orphan record remains evidence
only; it cannot authorize recovery or cleanup.

Relative direct entrypoints resolve against the consumer's kernel-observed cwd,
never the controller's cwd. A different canonical script or digest is unsupported.
`DeliveryProcessObservationError` exposes `PROCESS_CWD_UNAVAILABLE` or
`ENTRYPOINT_RESOLUTION_FAILED` and the underlying cause. Surface that diagnostic
to the controller/operator and repair the observation or launch path; do not
convert it to supports or bury it in a silent unknown retry loop. No guarded
effect executes, and a permit rejected during revalidation stays revoked even
after repairing the observation. Missing/dead processes or absent boot files
still return unknown.

If a floor is missing or invalid, return unknown without repairing the database.
Preserve uncertain rows and associated resources. Rollback of this inactive PR
removes the new modules; it requires no data rollback. A later active rollout
must follow its own offline cutover and prohibit an old consumer from reading a
migrated ledger.
