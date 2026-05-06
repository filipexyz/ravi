---
id: todos
title: Todos
kind: domain
domain: todos
capabilities:
  - scopes
tags:
  - todos
  - agents
  - identity
  - operations
applies_to:
  - src/todos
  - src/cli/commands/todos.ts
  - src/router
  - src/contacts.ts
  - src/tasks
owners:
  - ravi-dev
status: draft
normative: true
---

# Todos

## Intent

Todos are Ravi's lightweight commitment and checklist layer.

They exist for everyday follow-up, personal lists, agent checklists, session-specific next steps, and human-assigned reminders that do not require a full task runtime.

Todos MUST be cheaper and less ceremonial than tasks. They MUST still be durable, assignable, queryable, and auditable.

## Boundary With Tasks

`todo` is not `task`.

Use a todo when the system needs to remember or coordinate an action.

Use a task when Ravi needs tracked execution, dependency gating, dispatch, runtime attempts, report events, parent/child workflow state, or terminal delivery.

Todos MAY be promoted into tasks. Tasks MAY create todos as lightweight follow-ups. The two systems MUST NOT silently mirror each other.

## Core Objects

### `todo_list`

A named container for todo items.

Required fields:

- `id`
- `title`
- `description`
- `status`: `active`, `archived`, or `deleted`
- `owner_type`
- `owner_id`
- `scope_type`
- `scope_id`
- `created_by_type`
- `created_by_id`
- `created_from_session_key`
- `created_from_chat_id`
- `metadata_json`
- `created_at`
- `updated_at`

### `todo_item`

One actionable checklist entry.

Required fields:

- `id`
- `list_id`
- `title`
- `detail`
- `status`: `open`, `in_progress`, `done`, `blocked`, `cancelled`, or `deleted`
- `priority`: `low`, `normal`, `high`, or `urgent`
- `assignee_type`
- `assignee_id`
- `due_at`
- `completed_at`
- `blocked_reason`
- `metadata_json`
- `created_at`
- `updated_at`

### `todo_event`

Append-only history for audit and observation.

Events SHOULD include creation, update, status changes, assignment changes, due date changes, list archive, item deletion, promotion to task, and conversion from task.

## Actor Model

Todos MUST use Ravi semantic actor references instead of raw channel ids.

Allowed actor references:

- `contact:<contact_id>` for humans or organizations.
- `agent:<agent_id>` for Ravi agents.
- `platform_identity:<platform_identity_id>` only when the human has not been resolved to a contact yet.
- `system:<id>` for internal/system-owned lists.

Raw WhatsApp JIDs, LIDs, phone numbers, Telegram ids, or email strings MAY be accepted as input, but the write path MUST resolve them into a canonical actor or create an unresolved identity candidate.

## Ownership, Scope, and Assignment

Todos MUST separate:

- `owner`: who owns the list as a responsibility surface.
- `scope`: where the list belongs contextually.
- `assignee`: who should do a specific item.

Examples:

- Luis owns a personal list scoped globally.
- Agent `trt` owns a checklist scoped to session `trt-dev`.
- A list is scoped to a WhatsApp group chat but individual items are assigned to Luis and to an agent.
- A project owns a launch checklist while items are assigned to humans and agents.

See `todos/scopes` for the normative resolution rules.

## Context Inference

When a user asks Ravi to create a todo list, Ravi SHOULD infer defaults from the current context:

- In a session with a bound chat, default scope SHOULD be the current session or chat depending on wording.
- In a DM, "for me" SHOULD resolve to the current human contact.
- In an agent-specific group, an unspecified "for this agent" SHOULD resolve to that agent.
- If the user names a person or agent, Ravi MUST resolve the name before writing.

If the target is ambiguous or could assign responsibility to the wrong human, Ravi MUST ask a clarifying question.

Todo creation is low-risk, but assigning work to a human is still a social action. Ravi SHOULD prefer explicit confirmation when an inferred human assignee is not the requester.

## CLI Surface

The public CLI SHOULD be:

```bash
ravi todos lists
ravi todos list [--owner <actor>] [--scope <target>] [--assignee <actor>] [--status <status>]
ravi todos create-list "Title" [--owner <actor>] [--scope <target>]
ravi todos add <list> "Todo title" [--assignee <actor>] [--due <time>] [--priority <level>]
ravi todos check <item>
ravi todos uncheck <item>
ravi todos block <item> --reason "..."
ravi todos assign <item> <actor>
ravi todos move <item> <list>
ravi todos archive-list <list>
ravi todos promote <item> --task
```

The CLI MUST support bounded listing with limit/cursor/sort semantics consistent with `cli/listing`.

## Natural Language Surface

Ravi SHOULD support natural requests such as:

- "cria uma todo list pra mim"
- "cria uma lista pro agent trt"
- "adiciona isso na lista do grupo"
- "bota essa pendência pro Rapha"
- "quais todos estão abertos pra sessão dev?"
- "transforma esse todo em task"

The natural language layer MUST expose the resolved owner/scope/assignee in confirmations when there is any ambiguity.

## Tags

Todos SHOULD use the canonical tag registry for classification.

Asset types:

- `todo_list`
- `todo_item`

Tags are inert labels. Any automation that consumes todo tags MUST be explicit, explainable, and auditable under the `tags` spec.

## Events and Observation

Todo writes SHOULD emit structured events so observers and dashboards can track:

- list created
- item added
- item assigned
- item completed
- item blocked
- item promoted to task

Observers MAY summarize todos, but they MUST NOT auto-assign todos to humans unless a stored rule explicitly allows it.

## Acceptance Criteria

- A todo list can be owned by a contact, agent, platform identity, or system actor.
- A todo list can be scoped to a session, chat, agent, contact, project, task, or global surface.
- A todo item can be assigned independently of the list owner.
- Creating a todo from WhatsApp resolves the requester through Ravi identity metadata when available.
- Ambiguous humans or agents trigger clarification instead of silent assignment.
- Todo listing is bounded by default.
- A todo item can be promoted to a task without losing provenance.

## Known Failure Modes

- Treating todos as tasks and recreating the full task runtime.
- Treating a WhatsApp group as a human owner.
- Assigning an item to the wrong person because a display name matched loosely.
- Creating session-only todos that disappear from the human's personal list with no cross-reference.
- Letting agents silently create todos for humans without explainable origin.
- Unbounded todo lists flooding a runtime prompt.
