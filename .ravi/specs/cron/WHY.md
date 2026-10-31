# Cron / WHY

## Rationale

Cron jobs accumulate over time and their targets (agents, reply sessions) can
become stale. Without domain-level diagnostics, operators must open each job
individually to discover broken routing or missing agents.

## Decisions

- Keep target resolution read-only; target failures never auto-repair or auto-disable.
- Surface stale targets at list time so operators see problems without drilling in.
- Classify resolution states consistently across list, show, and doctor.

## Invalid shell ownership

A shell job owned by a non-operator cannot run under the existing authority
contract. Retrying it is not recovery. Disable it at load/cycle boundaries and
leave the row intact for inspection. Use the same owner predicate as execution,
including operator-bound contacts and legacy NULL; do not redefine ownership.

The atomic enabled-to-disabled update claims the notice without an in-memory
dedup cache or schema migration. Existing run history is preserved. A failed
notification or a crash after the update can lose the prompt, but the disabled
state, read-only ownership diagnostic and error log remain inspectable. A durable
notification outbox is outside this bounded fix.
