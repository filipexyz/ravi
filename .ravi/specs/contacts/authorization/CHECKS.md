---
id: contacts/authorization/checks
title: "Contact Authorization Checks"
kind: checks
domain: contacts
capability: authorization
---

# Contact Authorization Checks

## Regression Tests

- `contacts list` filters by `canAccessContact`.
- `contacts find` filters by `canAccessContact` for tag, identity, and text
  searches.
- `contacts info` and `contacts check` return not-found-equivalent output for
  hidden contacts.
- `contacts profile` and `contacts timeline` do not reveal hidden contacts.
- Pending/discovered queues require admin/write authority or filter to visible
  contacts.
- `crm contact`, `crm contacts`, `crm next`, `crm fact list`,
  `crm task list/show`, and opportunity/account contact views cannot reveal
  hidden contacts.
- Host services that expose contact data check the current context before
  returning profile/timeline/policy details.

## Audit Query

```sql
select subject_type, subject_id, relation, object_type, object_id, source,
       grant_mode, expires_at, revoked_at
from relations
where relation in (
  'read_contact',
  'read_own_contacts',
  'read_tagged_contacts',
  'write_contacts'
)
order by subject_type, subject_id, relation, object_type, object_id;
```
