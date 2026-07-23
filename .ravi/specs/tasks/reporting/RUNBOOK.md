# Task Reporting / RUNBOOK

## Debug Flow

1. Read the rules:
   `ravi specs get tasks/reporting --mode rules --json`.
2. For a status change, verify it goes through `ravi tasks report|done|block|fail`
   or the task service equivalent.
3. Validate required message, summary, blocker, or failure text before mutation.
4. Resolve assignment-level report settings before task-level settings.
5. Check `reportEvents` before publishing to a report target.
6. Keep checkpoint reminders separate from terminal report delivery.

## Validation

```bash
bun test src/tasks/service.test.ts src/cli/commands/tasks.test.ts src/tasks/checkpoint-runner.test.ts src/tasks/notify.test.ts src/runtime/observation-plane.test.ts
```
