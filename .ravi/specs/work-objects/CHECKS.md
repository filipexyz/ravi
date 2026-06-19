# Work Objects Checks

Run focused checks after changing this area:

```bash
bun test src/work-objects
bun test src/cli/registry-snapshot.test.ts
bun run typecheck
```

Smoke flow:

1. Create or pick a task.
2. Resolve it through `ravi work-objects resolve --type task --id <task-id> --json`.
3. Add a comment through `ravi work-objects action task <task-id> task.comment --value "..." --json`.
4. Verify `ravi tasks show <task-id> --json` includes the comment/event.
5. Edit priority through `ravi work-objects update task <task-id> --values '{"priority":"urgent"}' --json`.
6. Verify `ravi tasks show <task-id> --json` reflects the updated priority and a `task.updated` event.
7. Trigger Slack/Omni unfurl and verify it resolves through the same adapter.
