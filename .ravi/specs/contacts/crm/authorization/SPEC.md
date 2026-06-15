---
id: contacts/crm/authorization
title: "CRM Authorization"
kind: feature
domain: contacts
capability: crm
feature: authorization
capabilities:
  - provider-runtime
  - contact-visibility
  - crm
tags:
  - contacts
  - crm
  - permissions
  - visibility
applies_to:
  - src/contacts.ts
  - src/cli/commands/crm.ts
  - src/cli/commands/contacts.ts
  - src/permissions/scope.ts
owners:
  - ravi-dev
  - ravi-dev
status: active
normative: true
---

# CRM Authorization

## Intent

CRM authorization prevents relationship data from becoming a bypass around
contact privacy.

CRM state includes profiles, accounts, opportunities, tasks, activities, facts,
playbooks, ownership, health, lifecycle, notes, and next actions. This data can
be more sensitive than the contact record itself and MUST inherit contact
visibility by default.

## Invariants

- CRM read commands MUST not be globally `open` under runtime context.
- Any CRM read that returns contact-linked data MUST apply contact visibility.
- Account, opportunity, task, activity, and fact records MUST be returned only
  when at least one backing contact is visible, unless a future explicit CRM
  object grant authorizes that exact CRM object.
- CRM write commands MUST keep requiring `write_contacts system:*` or future
  narrower CRM mutation relations.
- CRM events and projections MUST preserve actor/source provenance.
- Hidden CRM entities SHOULD appear missing, not permission-denied, on lookup.

## Default Read Model

Until CRM object grants are implemented:

```text
visible_crm_contacts = contacts visible through canAccessContact(context)
visible_crm_accounts = accounts with at least one visible member/contact
visible_crm_opportunities = opportunities with at least one visible contact
visible_crm_tasks = tasks attached to a visible contact/account/opportunity
visible_crm_activities = activities attached to a visible contact
visible_crm_facts = facts attached to a visible contact/account/opportunity
```

If an entity cannot be mapped to a visible contact-backed path, it MUST be
excluded from lists and treated as missing on direct lookup.

## Future CRM Object Grants

Future relation names MAY include:

```text
read_crm_account crm_account:<id>
read_crm_opportunity crm_opportunity:<id>
read_crm_task crm_task:<id>
write_crm_account crm_account:<id>
write_crm_opportunity crm_opportunity:<id>
write_crm_task crm_task:<id>
```

Those grants MUST be explicit and auditable. They MUST NOT be inferred from CRM
ownership fields alone.

## Acceptance Criteria

- A runtime agent cannot use `crm contacts` to list hidden contacts.
- A runtime agent cannot use `crm next` to infer next actions for hidden
  contacts.
- A runtime agent cannot use account/opportunity membership views to infer
  hidden contacts.
- A runtime agent cannot read tasks, facts, or activities whose backing
  contacts are hidden.
- CRM reads remain available to direct local operator CLI.
