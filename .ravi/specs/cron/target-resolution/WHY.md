# Cron Target Resolution / WHY

## Rationale

When an agent is deleted or a reply session disappears, cron jobs that target
them silently fail or fall back to derived routing. Operators discover this
only when they open `ravi cron show` for each job.

Computing target health at list time makes staleness visible in the list
command itself. Adding a doctor check gives a single-command overview of all
broken cron targets.

## Decisions

- Compute resolution inline, never persist it. This keeps the cron schema
  unchanged and avoids stale-health-data problems.
- Classify `derived_key` as a warning even when the last run succeeded,
  because it indicates fragile routing that depends on key structure rather
  than a live session record.
- Shell jobs are not agent-targeted, so they skip agent-missing checks.
  Their `onError` notification target is diagnosed separately.

## Rejected Alternatives

- A persistent `cron_health` table: adds schema complexity and can itself
  become stale.
- Auto-disabling stale crons: risky mutation; operators should decide.
