# Task Reporting Delivery / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get tasks/reporting/delivery --mode rules --json`.
2. Confirm the state mutation happened through the task runtime.
3. Resolve effective report target and report events from assignment first,
   then task-level configuration.
4. If no report target exists, do not publish a report prompt.
5. Generate report prompts from task/profile/artifact context rather than
   assuming `TASK.md`.
6. For observed tasks, ensure observer authority owns durable synchronization.

## Validation

```bash
bun test src/tasks/service.test.ts src/cli/commands/tasks.test.ts src/tasks/notify.test.ts src/tasks/checkpoint-runner.test.ts src/runtime/observation-plane.test.ts src/runtime/observation-profiles.test.ts
```
