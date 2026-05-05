---
id: todos
title: Todos Runbook
kind: domain
domain: todos
status: draft
---

# Runbook

## Creating A Todo List From Chat

1. Resolve requester actor from current session/chat metadata.
2. Infer target owner from user wording.
3. Infer scope from current session/chat unless user names a different scope.
4. If assignee is a person or agent name, resolve it through contacts/agents.
5. If resolution is ambiguous, ask before writing.
6. Create list and report owner/scope.

## Debugging Wrong Assignment

Check:

- resolved requester contact/platform identity
- current session/chat binding
- list owner_type/owner_id
- item assignee_type/assignee_id
- todo events around creation/assignment
- whether natural language inference skipped clarification

## Promotion To Task

When promoting a todo item:

1. Create task with title/detail from todo.
2. Link task id to todo item metadata or dedicated relation.
3. Mark todo item as promoted or keep it open with `linked_task_id`.
4. Preserve original list, scope, assignee, creator, and created-from session.

Promotion MUST NOT delete the todo by default.

## Cleanup

Archived lists SHOULD remain queryable. Deleted lists/items SHOULD be soft-deleted first unless the operator explicitly runs a purge.
