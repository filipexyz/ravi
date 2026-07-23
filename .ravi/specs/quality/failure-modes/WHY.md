# Quality Failure Modes / WHY

## Rationale

Failure modes give raw observations a stable, named identity so recurring bad
behavior can be grouped, deduped, and routed instead of re-investigated from
scratch each time.

## Cron Blindness (`cron_blind_repeated`)

Recurring cron failures caused by host resource pressure (disk/temp
exhaustion) were previously indistinguishable from ordinary per-job flakes.
Each failing run risked spawning its own task, multiplying noise while hiding
the single real cause.

Design choices:

- Group these failures under one durable failure class keyed on the
  disk-pressure signature and day, so one incident does not create many tasks.
- Anchor detection on the `runtime.disk_space_low` doctor finding and the
  disk-pressure hint added to cron `lastError`/notification text, keeping
  evidence and interpretation separate.
- Keep classification read-only and approval-gated: the mode links evidence and
  remediation guidance, but any cleanup follows the doctor runbook under
  explicit human approval.

## Alternatives Rejected

- Treating each disk-driven cron failure as an independent flake was rejected
  because it buries the shared root cause and floods the task queue.
- Auto-remediating from within the failure mode was rejected; detection must
  not perform destructive cleanup.
