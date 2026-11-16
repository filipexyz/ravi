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

Only publish inside the consumer resolves a relative direct entrypoint. It
records the exact kernel argv1Raw and absolute canonical bundlePath. Supply the
same raw launch spelling in the independent inventory; the controller compares
strings, never resolves raw argv against either cwd, and checks only the declared
absolute bundle's realpath/digest. A different script binding/digest is unsupported.

A missing/unreadable absolute bundle returns unknown with
`error.code=DELIVERY_BOOT_OBSERVATION_FAILED` and a serializable cause (for example
ENOENT or EACCES). Inspect/acquire return that diagnostic without throwing raw
filesystem errors. Surface `snapshot.consumers[].error` to the operator, repair
the observation and acquire a fresh permit; never suppress it with supports or
bury it in a silent retry. A run rejected during revalidation stays revoked even
after repair. Missing/dead processes or absent boot files still return unknown.

If a floor is missing or invalid, return unknown without repairing the database.
Preserve uncertain rows and associated resources. Rollback of this inactive PR
removes the new modules; it requires no data rollback. A later active rollout
must follow its own offline cutover and prohibit an old consumer from reading a
migrated ledger.
