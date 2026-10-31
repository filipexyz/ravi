# Operating decisions

```bash
ravi decisions ask --task <task-id> --key window --ask "Which window?" --owner human:<contact-id> --blocks --json
ravi decisions ask --thread <child-session> --key window --ask "Which window?" --owner human:<contact-id> --execute --json
ravi decisions list --thread <child-session> --json
ravi decisions show <decision-id> --json
# From the authorized parent or operator, never the waiting worker:
ravi decisions answer <decision-id> --text "After 18h" --execute --json
ravi decisions retry <decision-id> --execute --json
```

Command authorization remains separate from origin authorization. Existing tasks/sessions grants are not silently expanded to the new namespace. Before rollout, the operator must explicitly provision the command capability for intended callers; this PR performs no live grant or provider mutation.

For `THREAD_DECISIONS_PENDING`, inspect open decisions and answer deliveries. `published` is waiting for runtime acceptance. A failed publication retries with backoff and can be retried explicitly. `DECISION_ORIGIN_MISMATCH` requires fixing the actual chat/session binding, never changing a decision's destination to another thread.

For `uncertain`, inspect `ravi sessions trace <child-session>` and the decision detail. Only the local operator, after establishing whether admission occurred, may run:

```bash
ravi decisions resolve-delivery <decision-id> --outcome received --evidence "Trace <turn-ref> shows admission" --execute --json
# Only after confirming no admission occurred:
ravi decisions resolve-delivery <decision-id> --outcome not_received --evidence "Trace <ref> and runtime inspection rule out admission" --execute --json
```

The finding is persisted in decision history. `received` permits closure without another turn; `not_received` retries the same immutable answer. This is an explicit operator recovery claim, not automated proof of execution.

Tables: decisions, decision_history, decision_deliveries. Legacy task_events remain available. The migration drops only the copied legacy table, inside one transaction. Never run old binaries against the upgraded DB: they would recreate a divergent task_decisions table. Roll back by stopping new writers and restoring a verified pre-upgrade backup, retaining a snapshot/export of post-upgrade answers for reviewed reconciliation. Do not drop generic tables as a rollback.
