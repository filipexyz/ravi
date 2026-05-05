---
id: todos
title: Todos Checks
kind: domain
domain: todos
status: draft
---

# Checks

## Unit Coverage

Implementation SHOULD include tests for:

- list creation with owner/scope defaults
- item creation with explicit assignee
- contact/agent/session/chat/project/task target resolution
- ambiguous contact resolution requiring clarification
- status transitions: open, in_progress, done, blocked, cancelled
- archive and soft delete behavior
- promotion of todo item to task with provenance
- tag attach/search for `todo_list` and `todo_item`
- bounded list output and cursor pagination

## Identity Safety

Regression tests MUST prove:

- a WhatsApp group cannot become a human owner
- display name alone does not merge or resolve humans
- unresolved platform identities are represented explicitly
- assigning to another human exposes resolved target in confirmation/output

## CLI Smoke

Expected smoke shape:

```bash
ravi todos create-list "TRT follow-ups" --owner agent:trt --scope session:trt-dev
ravi todos add <list-id> "Confirmar documentos obrigatorios" --assignee agent:trt
ravi todos list --scope session:trt-dev --limit 10
ravi todos check <item-id>
ravi todos promote <item-id> --task
```

## Database Checks

Suggested checks:

```sql
select status, count(*) from todo_lists group by status;
select status, count(*) from todo_items group by status;
select owner_type, count(*) from todo_lists group by owner_type;
select assignee_type, count(*) from todo_items group by assignee_type;
```

Orphan checks SHOULD verify that owner/scope/assignee references still resolve.

## Runtime Checks

The natural language path SHOULD be tested from:

- a DM
- a WhatsApp group
- an agent-specific session
- a project/task context

Each path SHOULD show the resolved owner, scope, and assignee.
