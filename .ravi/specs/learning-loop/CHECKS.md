# Learning Loop / CHECKS

## Checks

- The in-process cadence MUST dispatch the skill curador only at the configured turn interval, and a cycle over an empty delta MUST be skipped (no dispatch).
- Every skill write MUST pass through the guard; a direct SKILL.md edit that bypasses the guard MUST NOT be possible from the curador path.
- The guard MUST reject a write to a catalog/hub/hand-authored skill as protected, and MUST accept a write only to an agent-created skill.
- Retirement MUST archive the skill (recoverable) and MUST NOT hard-delete it.
- The read cursor MUST advance when a curador cycle completes and MUST leave it unchanged when the cycle fails, so the next cycle re-reads (at-least-once safe).
- Provenance on each write MUST be stamped by the runtime (date, agent, session, task), never supplied by the model.
