# Cron / WHY

## Rationale

Cron jobs accumulate over time and their targets (agents, reply sessions) can
become stale. Without domain-level diagnostics, operators must open each job
individually to discover broken routing or missing agents.

## Decisions

- Keep target resolution read-only; never auto-repair or auto-disable.
- Surface stale targets at list time so operators see problems without drilling in.
- Classify resolution states consistently across list, show, and doctor.
