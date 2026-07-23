# Task Reporting / CHECKS

## Checks

- Durable task status MUST be changed through the task runtime.
- Progress reports MUST include a non-empty message and MAY include a percent.
- Done, blocked, and failed mutations MUST require explanatory text.
- Assignment-level report settings MUST override task-level report settings.
- Report delivery MUST publish only for the effective `reportEvents` set.
- Checkpoint reminders MUST NOT be confused with terminal task state changes.
- Observer-driven status sync MUST be able to update durable state without
  requiring the worker prompt to include the default sync protocol.
- `bun test src/tasks/service.test.ts src/cli/commands/tasks.test.ts src/tasks/checkpoint-runner.test.ts src/tasks/notify.test.ts src/runtime/observation-plane.test.ts`
  SHOULD pass after changing task reporting.
