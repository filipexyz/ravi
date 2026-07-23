---
id: contacts/authorization
title: "Contact Authorization"
kind: capability
domain: contacts
capability: authorization
capabilities:
  - provider-runtime
  - visibility
  - crm
  - identity-graph
tags:
  - contacts
  - permissions
  - crm
  - visibility
applies_to:
  - src/contacts.ts
  - src/cli/commands/contacts.ts
  - src/cli/commands/crm.ts
  - src/permissions/scope.ts
  - src/runtime/host-services.ts
owners:
  - ravi-dev
  - ravi-dev
status: active
normative: true
---

# Contact Authorization

## Intent

Contact authorization protects people, organizations, identities, policies,
timelines, notes, tags, CRM state, and relationship history from being
discovered or mutated by unrelated agents.

Contacts are central identity records. They MUST be isolated by default.

## Invariants

- Contact discovery MUST be authorized. Search is disclosure.
- Contact reads MUST use `canAccessContact` or an equivalent context-aware
  helper.
- Contact writes MUST require `write_contacts system:*` or a future narrower
  write relation.
- `write_contacts system:*` implies read access to contacts because mutation
  requires target inspection.
- `read_own_contacts system:*` grants read only for contacts that have sessions
  routed to the current agent.
- `read_tagged_contacts system:<tag>` grants read only for contacts carrying
  that tag.
- `read_contact contact:<id>` grants read only for the concrete contact.
- Contact policy status is intake/reply policy, not Permission Provider Runtime authorization.
- Raw platform identities MUST NOT bypass canonical contact authorization.
- Hidden contacts SHOULD appear missing on lookup.

## Required Command Coverage

The following read surfaces MUST filter or deny through contact visibility:

- `contacts list`
- `contacts find`
- `contacts info`
- `contacts check`
- `contacts profile`
- `contacts timeline`
- pending/discovered contact queues
- identity lookup surfaces that return contact details
- runtime host services that expose contact/profile data

Pending/discovered queues are sensitive because they reveal unknown or
unapproved people. They MUST be admin-only or filtered to contacts visible to
the current principal.

## CRM Boundary

CRM reads MUST NOT bypass contact authorization.

Until explicit CRM object grants exist, any CRM command that returns people,
profile, account membership, opportunities, tasks, activities, facts, next
actions, or relationship history MUST resolve the backing contacts and apply
contact visibility.

If a CRM entity has no visible backing contact and no future explicit CRM grant
authorizes it, the entity MUST appear missing.

## Canonical Relations

```text
agent:<id> read_contact contact:<contact-id>
agent:<id> read_own_contacts system:*
agent:<id> read_tagged_contacts system:<tag>
agent:<id> write_contacts system:*

role:<id> read_contact contact:<contact-id>
role:<id> read_tagged_contacts system:<tag>
role:<id> write_contacts system:*
contact:<actor-contact-id> member role:<id>
```

## Acceptance Criteria

- A runtime agent without contact grants sees no unrelated contacts in
  `contacts list/find/info/check/profile/timeline`.
- `read_own_contacts` exposes only contacts connected to sessions routed to
  the current agent.
- `read_tagged_contacts system:vip` exposes only contacts tagged `vip`.
- `write_contacts system:*` can read and mutate contacts.
- CRM read commands cannot reveal hidden contacts through accounts,
  opportunities, tasks, facts, or next-action projections.
- A raw phone/LID/JID/email lookup does not reveal a hidden contact.
