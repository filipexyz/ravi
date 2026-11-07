# Diagnosis and decision

On `dev` at f4621d1c, `performSupervisedDaemonRestart` starts a second PM2 registration with `--force`, observes `online` plus a live PID twice, saves the process list, then deletes the predecessor. The successor is already free to initialize databases during those observations. PM2 membership and NATS leadership do not serialize SQLite schema access.

PR #769 restricts who may initialize production state and introduces component readiness, but neither restriction makes two admitted daemon processes mutually exclusive. Its marker sequence is invalidate → initialize → ready. A version marker is evidence of completion, not a lock. Router and outbox contain explicit transactions. The credentials table rebuild must disable foreign keys before its own transaction; a wrapping transaction would make that PRAGMA ineffective.

The schema surface includes lazy router-backed schemas beyond bootstrap, so a lock held only during daemon bootstrap is insufficient: the old daemon can later write schema again. Hold daemon ownership through process exit and serialize standalone component initialization by DB identity.

| Option | Benefit | Cost / failure mode |
| --- | --- | --- |
| Stop predecessor before spawning successor | Simple; works with a legacy predecessor | Loses the supervised standby and increases the availability gap; manual launches still need exclusion |
| Expiring lease plus fencing token | Can coordinate across machines | Every protected operation must enforce the token; a paused process otherwise resumes as a stale writer. A lock file with a timestamp is not fencing |
| Dedicated migration command/process only | Clear schema role | Requires removing lazy DDL, a deployment coordinator and explicit consumer quiescence; substantially larger change |
| Kernel lock plus supervised standby and per-DB initialization lock | Kernel arbitrates ownership, crash recovery has no stale-file race, transactions stay intact | Local-filesystem protocol; short service gap during handoff; first rollout must stop legacy writers |

**Recommendation: kernel ownership plus supervised standby.** A replacement first joins PM2 and proves it has reached the lock gate. The predecessor remains active until this standby is verified and persisted. The supervisor stops the predecessor by PM ID. The replacement can only open state after the kernel releases ownership, then migrates and advertises ready. Failure after stop is reported honestly and never treated as a schema rollback.

Per-database locks cover the entire read/check/migrate/marker interval. They are reentrant within a process for composed initializers and remain exclusive across processes. A database override shared by different state roots must use the same canonical lock. Readiness cannot be used to skip exclusion.

Sources: [SQLite transaction nesting](https://www.sqlite.org/lang_transaction.html), [foreign_keys PRAGMA](https://www.sqlite.org/pragma.html#pragma_foreign_keys), [kernel flock lifecycle](https://man7.org/linux/man-pages/man2/flock.2.html).
