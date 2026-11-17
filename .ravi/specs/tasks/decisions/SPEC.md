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
status: draft
normative: true
---

# Task Decisions

Tasks consume the generic `decisions` primitive. Consult `decisions` for lifecycle, history, migration, origin authorization and delivery rules.

- A decision MUST NOT add or change TaskStatus. `parked` MUST remain derived from an open blocking human-owned decision on a nonterminal, nonarchived task.
- Task mutations MUST project `task.decision.open` and `task.decision.answered` into task_events and existing task automations. No default task notification or resume is introduced.
- Task reads MUST project decisions from the generic ledger by task origin. `attention` groups visible open questions by task, oldest first; it MUST NOT detect stalls. `show` lists open first, then latest asked.
- `waitingFor` MUST prioritize human, then agent, then unassigned in the selected open rows. Archived tasks are excluded from attention.
- The active assignment session MUST NOT answer its own question. Generic error codes are `DECISION_SELF_ANSWER`, `DECISION_NOT_OPEN`, `DECISION_NOT_FOUND`.
- CLI writes MUST use `ravi decisions ask --task <id>` and `ravi decisions answer <decision-id>`. `tasks decide|answer` are removed. `tasks attention|show` remain task-specific reads.
- Internal task adapters MUST preserve task authorization, timestamps and event projections in the same write transaction as the generic mutation.
