# Quality Failure Modes / RUNBOOK

## Debug Flow

Use this runbook to confirm a failure mode classification and route it without
performing destructive actions.

```bash
# Inspect the failure-mode spec and its declared modes
ravi specs get quality/failure-modes --mode full --json
```

## Cron Blindness (`cron_blind_repeated`)

1. Confirm the signature: the failing cron job's `lastError` or notification
   text carries the `[disk-pressure]` hint (ENOSPC / no space left on device /
   temp-file creation failure).
2. Correlate with the doctor finding:

   ```bash
   ravi doctor --domain runtime --json   # check runtime.disk_space_low
   ravi cron show <id>                    # inspect last status/error
   ```

3. Group, do not fan out: multiple failing runs sharing the disk-pressure
   signature within the dedupe window are one incident, not many tasks.
4. Remediate under approval only: follow the "Safe Cleanup Plan" in
   `.ravi/specs/doctor/RUNBOOK.md`. Do not delete Ravi state, databases,
   artifacts, or models, and do not add automated cleanup.
5. Close the watch when `runtime.disk_space_low` passes and no further
   disk-pressure cron failures occur in the watch window.
