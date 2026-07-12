# Tasks Checks

## Runtime State Checks

- Task creation MUST persist the resolved profile id, version, source,
  snapshot, and input payload before dispatch.
- Dispatch MUST apply task-level model, effort, and thinking overrides without
  mutating the assigned session defaults.
- A turn without task binding MUST NOT inherit stale `RAVI_TASK_*` environment
  from previous task work.
- `show` and `watch` MUST be side-effect free and MUST NOT materialize missing
  task artifacts.
- `report`, `done`, `block`, and `fail` MUST update durable task state and task
  events through the task runtime.

## Commands

- `bun test src/tasks/service.test.ts src/tasks/runtime-options.test.ts`
- `bun test src/cli/commands/tasks.test.ts src/cli/commands/tasks-profiles.test.ts`
