---
id: contacts/crm/authorization/checks
title: "CRM Authorization Checks"
kind: checks
domain: contacts
capability: crm
feature: authorization
---

# CRM Authorization Checks

## Regression Tests

- `crm contacts --json` excludes contact profiles for hidden contacts.
- `crm contact <hidden-contact> --json` returns a not-found-equivalent error.
- `crm next --json` excludes hidden contact next actions.
- `crm fact list <hidden-contact> --json` does not return facts.
- `crm task list --json` excludes tasks attached only to hidden contacts.
- `crm task show <task-for-hidden-contact> --json` is not visible.
- Account and opportunity contact views hide hidden contacts.

## Manual Checks

```bash
ravi specs get contacts/crm/authorization --mode rules --json
```
