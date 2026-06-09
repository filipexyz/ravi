---
id: permissions/profiles/checks
title: "Permission Profile Checks"
kind: checks
domain: permissions
capability: profiles
---

# Permission Profile Checks

## Regression Tests

- Grant `role:reader use toolgroup:read-only` and
  `contact:c1 member role:reader`; assert the delegated context for `c1`
  materializes read-only tools with profile provenance.
- Grant `role:apps use app:khal-tasks` and
  `contact:c1 member role:apps`; assert `apps list` includes `khal-tasks` for
  `c1` and excludes it after membership revocation.
- Grant `role:mutator execute app:khal-tasks` without `use app:khal-tasks`;
  assert exact mutating dispatch can authorize but discovery does not list the
  app unless `use` is also present.
- Add `chat:public constrain role:read-only`; assert the same owner contact can
  use fewer tools in that chat than in a private owner chat.
- Expire a profile grant and assert the next context omits it.

## Audit Queries

```sql
select subject_type, subject_id, relation, object_type, object_id, source,
       grant_mode, expires_at, revoked_at
from relations
where subject_type = 'role'
   or object_type = 'role'
order by subject_type, subject_id, relation, object_type, object_id;
```
