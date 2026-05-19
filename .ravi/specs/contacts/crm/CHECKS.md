# Contact CRM Checks

## Static Checks

- CRM lifecycle/status is stored outside `contact_policies.status`.
- No CRM table uses raw channel ids as canonical identity.
- Account records reference org contacts when an org identity is known.
- Every write path inserts into `crm_events`.
- Contact-related CRM writes also create or link `contact_events`.
- Group/chat references use canonical `chat_id` or raw provenance fields, not fake contacts.
- Agent-discovered facts can remain proposed until confirmed.
- CRM create/write paths with `idempotency_key` do not duplicate rows or audit events.
- Contact merges move CRM projections and relationship edges from source contact to target contact.

Suggested scans after implementation:

```bash
rg -n "crm_events|crm_contact_profiles|crm_accounts|crm_opportunities|crm_tasks" src
rg -n "contact_policy\\.status|status.*lead|status.*qualified|status.*churned" src
rg -n "platform_user_id|raw_sender_id|normalized_sender_id|chat_id" src/crm src/contacts.ts src/cli/commands/contacts.ts
```

## Required Tests

- Creating a CRM contact profile does not mutate contact access policy.
- Updating lifecycle writes `crm_events` and projects to the current profile row.
- Linking a contact to an account writes account membership and a contact timeline event.
- Creating an opportunity can target account, contact, or both.
- Moving an opportunity stage writes an event with previous and next stage.
- Creating a task makes it appear in `crm_next_actions`.
- Completing a task removes it from open next actions and writes completion event.
- Proposing and confirming CRM facts writes audit events and contact timeline events.
- Opportunity stakeholder links can make a non-primary contact visible in that contact's CRM card.
- Projecting a contact event into CRM activity links the contact as an activity participant.
- Merging two contacts preserves account memberships, opportunity links, tasks, activities, and facts on the target contact.
- `contacts profile --include-crm` returns CRM data without scanning raw message history.

## Smoke Commands

```bash
bun test src/cli/commands/contacts.test.ts
bun run build
bin/ravi specs get contacts/crm --mode rules --json
```
