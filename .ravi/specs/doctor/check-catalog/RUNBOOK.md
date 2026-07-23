# Doctor Check Catalog / RUNBOOK

## Debug Flow

Use this catalog to map a doctor finding id back to its severity, evidence
shape, and thresholds, then follow the parent doctor runbook for remediation.

```bash
# List catalog contents and evidence contracts
ravi specs get doctor/check-catalog --mode full --json

# Inspect live findings for a domain
ravi doctor --domain runtime --json
```

## Disk And Temp Pressure (`runtime.disk_space_low`)

1. Run `ravi doctor --domain runtime --json` and read the `runtime.disk_space_low`
   finding. Evidence lists each target (`cwd`, `temp`, `state`) with a redacted
   path label, `freeBytes`, `percentUsed`, `deviceId` when available,
   `writeProbeOk`, and the applied `thresholds`.
2. Severity maps directly to action:
   - `error`: free below the critical floor (1 GiB), used at/above 97%, or the
     write/remove smoke probe failed — stop and free space before proceeding.
   - `warn`: free below the operational margin (5 GiB) or used at/above 90% —
     review and plan cleanup.
   - `pass`/`info`: healthy, context only.
3. The check is read-only. For approved cleanup steps and the explicit
   do-not-delete list (Ravi state, databases, artifacts, models), follow the
   "Safe Cleanup Plan" in `.ravi/specs/doctor/RUNBOOK.md`.
4. Re-run `ravi doctor --domain runtime --json` after any approved cleanup to
   confirm the finding cleared.

If the host is too full for the command itself to run, report it explicitly
rather than hiding it, and escalate for approved manual cleanup.
