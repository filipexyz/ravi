# Learning Loop / CHECKS

## Checks

- The durable cadence MUST dispatch each curator only at its configured terminal-turn interval, survive restart and skip an empty delta.
- Missing state MUST reconstruct phase without historical task replay and seed missing watermarks at the current cursor.
- Curator/report sessions MUST NOT tick, and an active/blocked curator MUST suppress duplicate dispatch for the same origin session.
- A nominal Claude success containing explicit weekly/session limit text with zero usage MUST become `turn.failed`; a task-bound quota failure MUST persist `blocked`.
- Every skill write MUST pass through the guard; a direct SKILL.md edit that bypasses the guard MUST NOT be possible from the curador path.
- The guard MUST reject a write to a catalog/hub/hand-authored skill as protected, and MUST accept a write only to an agent-created skill.
- Retirement MUST archive the skill (recoverable) and MUST NOT hard-delete it.
- The read cursor MUST advance when a curador cycle completes and MUST leave it unchanged when the cycle fails, so the next cycle re-reads (at-least-once safe).
- Provenance on each write MUST be stamped by the runtime (date, agent, session, task), never supplied by the model.
