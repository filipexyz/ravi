# Task Decisions / CHECKS

## Checks

- The task status enum MUST stay `open|dispatched|in_progress|blocked|done|failed`.
  A decision command MUST NOT write `tasks.status`.
- `task_decisions` MUST have a partial unique index: one `open` row per
  `(task_id, key)`.
- Re-deciding an open key MUST return `created: false` and the same `id`.
- `answer` on a non-open key MUST throw `TASK_DECISION_NOT_OPEN` (and
  `TASK_DECISION_NOT_FOUND` when the key was never asked) without touching the
  answered row.
- Answering from the active assignment session MUST fail with
  `TASK_DECISION_SELF_ANSWER` and leave the decision open.
- Every mutation MUST produce a `task.decision.open` / `task.decision.answered`
  event with actor and timestamp.
- `attention` MUST be side-effect free: no event, no row, no timestamp changes.
- `parked` MUST require `open + blocks + owner_type = human` on a non-terminal,
  non-archived task. Agent-owned or unassigned decisions MUST NOT park a task.
- `attention` entries MUST be ordered by age descending and be stable for the
  same rows and clock.
- `show` MUST print decisions with open entries first and MUST NOT mutate state.
- Usage errors MUST exit 2; not-found, not-open and self-answer MUST exit 1.
- `bun test src/tasks/ src/cli/commands/tasks.test.ts` SHOULD pass after changing
  the decisions capability.
- `bun run typecheck` SHOULD pass.
