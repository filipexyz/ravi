---
id: tasks/decisions
title: "Task Decisions"
kind: capability
domain: tasks
capability: decisions
capabilities:
  - decide
  - answer
  - attention
  - parked
tags:
  - tasks
  - decisions
  - attention
  - events
applies_to:
  - src/tasks/decisions.ts
  - src/tasks/task-db.ts
  - src/tasks/service.ts
  - src/tasks/types.ts
  - src/tasks/automations.ts
  - src/cli/commands/tasks.ts
  - src/cli/commands/operational-return-schemas.ts
  - design/ravi-task-runtime-v0.md
owners:
  - ravi-dev
status: active
normative: true
---

# Task Decisions

## Intent

A decision is a pending question attached to a task, with an owner and a stable
key. It exists so a question is never buried in a comment: the runtime records
who asked, who owns the answer, whether the task is parked on it, who answered
and when.

Decisions separate two things the task runtime used to conflate: an obstacle
(`blocked` with a free-text reason) and a pending question that needs someone
else to decide.

## Boundaries

Task Decisions own:

- the durable `task_decisions` record (same task DB);
- the `decide`, `answer` and `attention` CLI surface;
- `task.decision.open` and `task.decision.answered` task events;
- the deterministic attention fold over open decisions;
- the `Decisions` section of `ravi tasks show`.

Task Decisions do not own:

- task status. A decision is metadata; `open|dispatched|in_progress|blocked|done|failed`
  is unchanged and no decision command may write it;
- stall or blocked detection. `attention` reads decisions only; a future
  runtime/signals producer may consume the decision events, and this capability
  does not integrate with `src/signals`;
- observer behavior. The built-in observer neither opens nor answers decisions
  and has no command path for either;
- channel delivery, prompts, or steering. A decision does not dispatch, resume,
  or notify anyone by itself.

## Model

`task_decisions` columns:

- `id` (`dec_<uuid hex>`), `task_id`, `key`;
- `status` in `open|answered|superseded`;
- `owner_type` in `human|agent|unassigned`, `owner_id` (contact id or agent id,
  `NULL` when unassigned);
- `ask`, `asked_by`, `asked_at`;
- `answer`, `answered_by`, `answered_at`;
- `blocks` (`0|1`): the task is parked on this decision;
- `created_at`, `updated_at`.

A partial unique index enforces at most one `open` decision per
`(task_id, key)`. Re-deciding an open key updates `ask`, `owner_type`,
`owner_id` and `blocks` in place (same id), preserving `asked_by` and `asked_at`
so attention age stays honest. A new ask after the decision was answered creates
a new record.

## Invariants

- A decision MUST NOT introduce a new `TaskStatus` or transition the task.
- Every mutation MUST attribute an actor and a timestamp and MUST emit an event
  (`task.decision.open` or `task.decision.answered`), following the
  `report|done|block|fail` pattern.
- `answer` on a key that is not open MUST fail with a typed error
  (`TASK_DECISION_NOT_OPEN`) and MUST NOT rewrite the answered record. A key
  that was never asked fails with `TASK_DECISION_NOT_FOUND`.
- The worker session that holds the active assignment MUST NOT answer its own
  decision: that is `TASK_DECISION_SELF_ANSWER`.
- The built-in observer MUST NOT open or answer decisions.
- `attention` and `show` MUST be deterministic, side-effect free reads.
- `attention` MUST group open decisions by task, ordered by age (oldest first),
  and MUST NOT detect stalls or blocked tasks.
- `parked` is derived, not stored: a task is parked when it has an open decision
  with `blocks = 1` and `owner_type = human`, and the task is neither terminal
  nor archived.
- `waitingFor` is `human` when any open decision of the task is owned by a human,
  else `agent`, else `unassigned`.
- Validation failures (missing/invalid key, invalid owner, missing ask/text) are
  usage errors (exit 2) and MUST fail before any write.

## CLI Surface

```bash
ravi tasks decide <task-id> --key <k> --ask "..." [--owner human:<contact>|agent:<id>|unassigned] [--blocks] [--json]
ravi tasks answer <task-id> --key <k> --text "..." [--by <actor>] [--json]
ravi tasks attention [--agent <id>] [--owner human|agent|unassigned] [--task <id>] [--json]
ravi tasks show <task-id>            # includes the Decisions section (open first)
```

Exit codes: `1` for a missing task, an unknown/closed decision key, or a
self-answer; `2` for usage errors (missing `--key`/`--ask`/`--text`, malformed
owner, unknown `--owner` filter for attention).

`attention --json` shape:

```json
{
  "kind": "task.decision.attention",
  "generatedAt": 1730000000000,
  "total": 1,
  "parkedCount": 1,
  "decisionCount": 1,
  "filters": {},
  "entries": [
    {
      "taskId": "task-...",
      "taskTitle": "...",
      "taskStatus": "in_progress",
      "taskPriority": "high",
      "assigneeAgentId": "dev",
      "assigneeSessionName": "task-...-work",
      "parked": true,
      "waitingFor": "human",
      "ageSeconds": 3600,
      "decisionCount": 1,
      "decisions": [
        { "id": "dec_...", "key": "deploy-window", "ask": "...", "ownerType": "human",
          "ownerId": "contact-1", "askedBy": "dev-session", "askedAt": 1730000000000,
          "blocks": true, "ageSeconds": 3600 }
      ]
    }
  ]
}
```

## Events

- `task.decision.open` — emitted on every `decide` (including a re-ask).
- `task.decision.answered` — emitted on every `answer`.

Both are in the task event union, appear in task stream snapshots, and are
accepted by `ravi tasks automations add|set --on`.

## Acceptance Criteria

- Re-deciding the same open key updates one record; no duplicate row exists.
- `answer` closes the record once; a second answer fails with a typed error.
- A worker answering from its own active assignment session is rejected.
- An open blocking decision owned by a human makes the task `parked` in
  `attention`; an agent-owned decision does not.
- `attention` filters (`--agent`, `--owner`, `--task`) only narrow the fold.
- `show` prints answered and open decisions with open first and mutates nothing.
- Automation `--on task.decision.open` and `--on task.decision.answered` fire.

## Validation

See `CHECKS.md`.
