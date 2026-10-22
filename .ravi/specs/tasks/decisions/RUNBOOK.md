# Task Decisions / RUNBOOK

## Where the data lives

- Table `task_decisions` in the Ravi SQLite DB (`~/.ravi/ravi.db`), same file as tasks.
- One partial unique index guarantees a single `open` row per `(task_id, key)`.
- Events land in `task_events` as `task.decision.open` / `task.decision.answered`.
- The task's `updated_at` is touched by both mutations, so activity-ordered listings see
  the question.

## Daily operation

```bash
# What is waiting on a human, oldest first
ravi tasks attention
ravi tasks attention --owner human --json
ravi tasks attention --agent dev --json

# Ask and answer
ravi tasks decide <task-id> --key deploy-window --ask "Which window?" --owner human:<contact>
ravi tasks answer <task-id> --key deploy-window --text "After 18h"

# Inspect one task
ravi tasks show <task-id>            # Decisions section, open first
```

## Common failures

**`TASK_DECISION_SELF_ANSWER` (exit 1).** The command ran inside the same session that is
the task's active assignment. Answer from the requesting session, a human turn, or another
agent session. Do not try to bypass it with `--by`.

**`TASK_DECISION_NOT_OPEN` (exit 1).** The key was already answered or superseded.
Answered history is immutable. Open a new key for a new question; if the old answer was
wrong, ask again under a new key and reference the old one in the ask text.

**`TASK_DECISION_NOT_FOUND` (exit 1).** No row for that key on that task. Check the key
slug: keys are lowercase, `[a-z0-9._-]`, max 64 chars. `ravi tasks show <id>` lists them.

**`TASK_DECISION_INVALID_OWNER` (exit 2).** Owner must be `human:<contact-id>`,
`agent:<agent-id>`, or omitted for `unassigned`. A bare name is never inferred.

**A task looks parked but nobody is being told.** `parked` only means
`open + blocks + owner=human` on a non-terminal, non-archived task. It does not deliver
anything. Delivery is the signals plane's job; this capability only records the question.

**Two answers at once.** The answer runs in one `BEGIN IMMEDIATE` transaction with a
`status = 'open'` guard, so the loser gets `TASK_DECISION_NOT_OPEN` instead of silently
overwriting the winner.

## Debugging a decision that "disappeared"

1. `ravi tasks show <task-id> --json` and look at `decisions` (all statuses).
2. Query the rows directly when the CLI is unavailable:
   ```bash
   sqlite3 ~/.ravi/ravi.db \
     "select key,status,owner_type,owner_id,asked_at,answered_at from task_decisions where task_id='<task-id>' order by asked_at desc;"
   ```
3. Check the event trail:
   ```bash
   sqlite3 ~/.ravi/ravi.db \
     "select type,actor,message,created_at from task_events where task_id='<task-id>' and type like 'task.decision.%' order by id;"
   ```
4. Archived tasks are excluded from `attention` on purpose. If a question must surface
   again, unarchive the task; do not duplicate the decision.

## Rolling back

The feature is additive. Dropping `task_decisions` and the two event types leaves every
other task surface intact: the status enum, automations on `blocked|done|failed`, the
observer and the checkpoint runner are untouched.
