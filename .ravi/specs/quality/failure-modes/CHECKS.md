# Quality Failure Modes / CHECKS

## Checks

- Every failure mode MUST declare a stable snake_case `id`, `scope`,
  `severity`, detection sources, evidence fields, and a dedupe key.
- Detection predicates MUST state which sources are authoritative and MUST
  separate evidence from interpretation.
- Severity MUST reflect operational impact, not emotional salience.
- Dedupe keys MUST prevent one production incident from creating many tasks.

### `cron_blind_repeated`

- The mode MUST fire only when recurring cron shell failures carry a
  disk-pressure signature (ENOSPC / no space left on device / temp-file
  creation failure) classified into `lastError` or notification text.
- Evidence MUST include the cron job id, last status, last error, the
  disk-pressure hint, and a reference to the `runtime.disk_space_low` doctor
  finding.
- The dedupe key MUST collapse repeated same-day disk-pressure failures into a
  single grouped incident, not one task per run.
- Classification MUST remain read-only; it MUST NOT delete, prune, or move any
  files, and any cleanup MUST stay behind explicit human approval.
- The watch MUST close only when `runtime.disk_space_low` passes and no further
  disk-pressure cron failures occur in the window.
