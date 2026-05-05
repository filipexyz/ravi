---
id: todos/scopes
title: Todo Scopes and Assignment
kind: capability
domain: todos
capability: scopes
tags:
  - todos
  - identity
  - sessions
  - assignment
applies_to:
  - src/todos
  - src/cli/commands/todos.ts
  - src/router/sessions.ts
  - src/contacts.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Todo Scopes and Assignment

## Intent

Todo scopes define where a list belongs. Assignment defines who should act. Ownership defines who is responsible for the list.

These concepts MUST remain separate.

## Definitions

- `owner`: actor responsible for the list as a surface.
- `scope`: context where the list should appear by default.
- `assignee`: actor expected to complete one item.
- `requester`: actor who asked Ravi to create or modify the todo.
- `creator`: agent/system/runtime actor that performed the write.

## Owner Types

Allowed owner references:

- `contact:<id>`
- `agent:<id>`
- `platform_identity:<id>`
- `system:<id>`

`platform_identity` ownership SHOULD be temporary. When a platform identity resolves to a contact or agent, the todo list SHOULD be migratable.

Chats, sessions, projects, and tasks MUST NOT be owners. They are scopes.

## Scope Types

Allowed scope references:

- `global:<id>` for a broad user/system namespace.
- `session:<session_key>`
- `chat:<chat_id>`
- `agent:<agent_id>`
- `contact:<contact_id>`
- `project:<project_id>`
- `task:<task_id>`
- `workflow_run:<workflow_run_id>`

Scopes are query surfaces. They do not imply assignment.

## Assignee Types

Allowed assignee references:

- `contact:<id>`
- `agent:<id>`
- `platform_identity:<id>`
- `system:<id>`
- `none`

An item MAY be unassigned. Unassigned items are still owned by the list owner and visible through the list scope.

## Default Inference Rules

### "For me"

In a DM or identifiable chat, "for me" MUST resolve to the requester's contact when available.

If the requester has only a platform identity and no contact, Ravi MAY use `platform_identity:<id>` and SHOULD surface that it has not resolved the person yet.

### "For this agent"

If the current session has exactly one active Ravi agent, "for this agent" SHOULD resolve to `agent:<agent_id>`.

If the chat includes multiple agents or the wording is ambiguous, Ravi MUST ask.

### "For this session"

"For this session" MUST use `scope=session:<session_key>`.

Owner SHOULD default to the requester unless the request says the list belongs to the agent.

### "For this group/chat"

"For this group" or "for this chat" MUST use `scope=chat:<chat_id>`.

It MUST NOT create a contact for the group.

### "For person X"

Ravi MUST resolve person names through contacts/platform identities.

Display-name-only weak matches MUST ask for confirmation when there is more than one candidate or low confidence.

### "For agent X"

Ravi MUST resolve agent names through the agent registry.

Unknown agents MUST be rejected or clarified before write.

## Examples

### Personal List

```text
owner=contact:luis
scope=contact:luis
item.assignee=contact:luis
```

### Agent Checklist

```text
owner=agent:trt
scope=agent:trt
item.assignee=agent:trt
```

### Session Checklist

```text
owner=agent:trt
scope=session:trt-dev
item.assignee=agent:trt
```

### Group Shared List

```text
owner=contact:luis
scope=chat:ravi-trt
item.assignee=contact:luis | agent:trt | none
```

### Project Checklist

```text
owner=contact:luis
scope=project:proj_x
item.assignee=agent:dev
```

## Visibility Rules

A todo list SHOULD appear when querying any matching surface:

- owner query
- scope query
- assignee query
- tag query
- created-from session query

Visibility does not grant permission to modify. Mutation permission MUST be checked separately.

## Permissions

Initial policy SHOULD be conservative:

- The requester may create personal todos.
- The current routed agent may create agent/session-scoped todos for itself.
- Creating todos assigned to another human SHOULD require either explicit user request in the current message or permission.
- System automation assigning todos to humans MUST require a stored rule and audit.

## Audit

Every inference SHOULD record:

- raw user wording or command args
- inferred owner
- inferred scope
- inferred assignee
- confidence
- whether the user confirmed
- session/chat/requester provenance

## Acceptance Criteria

- Owner, scope, and assignee can differ on the same item.
- Group chats are only scopes, never human owners.
- Session-scoped todos remain queryable by session even if assigned to a person.
- Person-scoped todos remain queryable by person even if created from a group.
- Ambiguous person/agent targets do not write silently.
