---
id: permissions/profiles/checks
title: "Permission Profile Checks"
kind: checks
domain: permissions
capability: profiles
---

# Permission Profile Checks

## Regression Tests

- `ravi permissions legacy --json` plans active manual permanent wildcard or
  trailing-pattern grants and does not revoke anything.
- `ravi permissions legacy --apply --json` without `--confirm
  legacy-cleanup` fails before changing relation state.
- `ravi permissions legacy --apply --confirm legacy-cleanup --limit 1 --json`
  revokes only one selected manual permanent legacy grant and leaves
  config/policy/temporary grants untouched.
- Grant `role:reader use toolgroup:read-only` and
  `contact:c1 member role:reader`; assert the delegated context for `c1`
  materializes read-only tools with profile provenance.
- Grant `role:apps use app:khal-tasks` and
  `contact:c1 member role:apps`; assert `apps list` includes `khal-tasks` for
  `c1` and excludes it after membership revocation.
- Attach `policy.profile.trusted-dev` to `contact:c1`; assert the matching
  permission policy materializes `contact:c1 member role:trusted-dev` as a
  temporary grant with policy provenance.
- Remove `policy.profile.trusted-dev` from `contact:c1`; assert policy
  reconcile removes only policy-owned membership and leaves manual membership
  untouched.
- Attach `policy.profile.owner` to `contact:c1`; assert policy materialization
  rejects membership when `role:owner` closure contains `admin system:*`.
- Add `use tool:*` to an already policy-managed role; assert role closure
  revalidation revokes or suspends policy-owned memberships before the next
  authority check.
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

Policy-managed profile memberships:

```sql
select subject_type, subject_id, relation, object_type, object_id, source,
       grant_mode, expires_at, revoked_at
from relations
where relation = 'member'
  and object_type = 'role'
  and source like 'policy:%'
order by source, subject_type, subject_id, object_id;
```
