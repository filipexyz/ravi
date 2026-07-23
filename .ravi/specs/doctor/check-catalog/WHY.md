# Doctor Check Catalog / WHY

## Rationale

The check catalog exists so every doctor finding has a stable identity,
severity, and evidence contract that downstream automation (CI gates,
watchdogs, triggers) can depend on without re-deriving semantics per release.

## Disk And Temp Pressure

The `runtime.disk_space_low` check was added because host disk/temp exhaustion
had been surfacing only as opaque downstream failures (cron jobs failing with
generic exit codes, temp-file creation errors) rather than a first-class,
diagnosable health signal.

Design choices:

- Measure three targets — current working directory, OS temp dir, and the Ravi
  state dir — because exhaustion on any one of them breaks a different class of
  operations, and they can live on different mounts.
- Use both a free-bytes floor and a percent-used ceiling so the check fires
  correctly on small and large volumes alike.
- Include a minimal write/remove smoke probe because "free bytes reported" and
  "actually writable" can diverge (read-only remounts, quota, inode
  exhaustion).
- Keep the check strictly read-only and redact private paths to `~`-relative
  labels so it is safe to run in agent sessions, CI, and incident triage.

## Alternatives Rejected

- Auto-cleanup inside the check was rejected: a health check must stay
  read-only and predictable. Any destructive remediation stays behind explicit
  human approval per the runbook.
- Reporting only free bytes (no probe) was rejected because it misses
  writability failures that are not pure space exhaustion.
