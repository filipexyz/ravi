# Work Objects Checks

Run focused checks after changing this area:

```bash
bun test src/work-objects
bun test src/cli/registry-snapshot.test.ts
bun run typecheck
```

- `bun test src/work-objects` MUST pass after changing domain adapters.
- `bun test src/cli/registry-snapshot.test.ts` MUST pass after exposing command
  surfaces.
- Work Object IDs MUST remain provider-owned external references.
- Domain adapters MUST own validation, authorization hooks, mapping, and
  mutation semantics.
- Transport adapters MUST NOT contain task, artifact, page, or session business
  logic.
- Unsupported fields or transitions MUST return structured field errors.

Smoke flow:

1. Create or pick a task.
2. Resolve it through `ravi work-objects resolve --type task --id <task-id> --json`.
3. Add a comment through `ravi work-objects action task <task-id> task.comment --value "..." --json --execute`
   (without `--execute` the CLI brake prints the plan and exits 3).
4. Verify `ravi tasks show <task-id> --json` includes the comment/event.
5. Edit priority through `ravi work-objects update task <task-id> --values '{"priority":"urgent"}' --json`.
6. Verify `ravi tasks show <task-id> --json` reflects the updated priority and a `task.updated` event.
7. Trigger Slack/Omni unfurl and verify it resolves through the same adapter.
