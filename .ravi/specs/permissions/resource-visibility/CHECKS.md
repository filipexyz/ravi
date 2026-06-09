---
id: permissions/resource-visibility/checks
title: "Resource Visibility Checks"
kind: checks
domain: permissions
capability: resource-visibility
---

# Resource Visibility Checks

## Regression Tests

- Create two agents, grant one only `execute group:apps`, and assert
  `apps list --json` returns only apps covered by `use app:<id>`.
- Assert `apps show <hidden-id> --json` returns the same external error shape
  as an unknown app when called under runtime context.
- Assert a hidden app root alias is not resolved by `maybeRunAppAliasRoute`.
- Assert `agents list --json` hides non-self agents without `view agent:<id>`.
- Assert `agents show <hidden-agent> --json` does not reveal the hidden agent.
- Assert `sessions list/info/read/trace --json` hides sessions without
  `access session:<id>`.
- Assert session mutation commands require `modify session:<id>`.
- Assert `contacts list/find/info/check/profile/timeline --json` hide contacts
  without `read_contact`, `read_own_contacts`, `read_tagged_contacts`, or
  `write_contacts`.
- Assert `crm contact/contacts/next/fact/task/opportunity` commands cannot
  reveal records attached only to hidden contacts.

## Audit Queries

```sql
select subject_type, subject_id, relation, object_type, object_id, source
from relations
where relation in (
  'view',
  'access',
  'modify',
  'use',
  'execute',
  'read_contact',
  'read_own_contacts',
  'read_tagged_contacts',
  'write_contacts'
)
order by subject_type, subject_id, relation, object_type, object_id;
```

```bash
ravi specs get permissions/resource-visibility --mode rules --json
```
