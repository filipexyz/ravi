# Task Reporting Delivery / CHECKS

## Checks

- Chat text alone MUST NOT be considered durable task progress.
- `ravi tasks report` MUST reject empty progress messages.
- `ravi tasks done`, `block`, and `fail` MUST reject missing terminal
  explanations.
- Report prompts MUST publish only when a report target and matching event are
  configured.
- Report delivery MUST use assignment-level settings before task-level settings.
- Report prompt generation MUST use task/profile/artifact context, not hardcoded
  `TASK.md` assumptions.
- Observed-task workers SHOULD be able to avoid direct task-sync commands while
  an observer owns durable synchronization.
- `bun test src/tasks/service.test.ts src/cli/commands/tasks.test.ts src/tasks/notify.test.ts src/tasks/checkpoint-runner.test.ts src/runtime/observation-plane.test.ts src/runtime/observation-profiles.test.ts`
  SHOULD pass after changing task reporting delivery.
