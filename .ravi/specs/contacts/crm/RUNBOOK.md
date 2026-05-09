# Contact CRM Runbook

## Before Implementation

Read the required contacts/channel specs:

```bash
bin/ravi specs get channels --mode rules --json
bin/ravi specs get channels/chats --mode rules --json
bin/ravi specs get contacts --mode rules --json
bin/ravi specs get contacts/identity-graph --mode rules --json
bin/ravi specs get contacts/identity-graph/unified-model --mode rules --json
bin/ravi specs get contacts/profile-card --mode rules --json
bin/ravi specs get contacts/crm --mode rules --json
```

Inspect existing storage:

```bash
rg -n "CREATE TABLE IF NOT EXISTS contacts|contact_policies|contact_events|contacts_meta|platform_identities" src/contacts.ts
rg -n "CREATE TABLE IF NOT EXISTS chats|chat_participants|session_participants" src/router/router-db.ts
```

## Implementation Order

1. Add CRM table creation in the contacts/database initialization layer.
2. Add typed schema rows and JSON parse/serialize helpers.
3. Add append-only `crm_events` writer first.
4. Add projection writers for `crm_contact_profiles`, `crm_accounts`, `crm_account_contacts`, `crm_opportunities`, and `crm_tasks`.
5. Add contact timeline projection for contact-related CRM writes.
6. Add read APIs for next actions, contact CRM card, account card, and opportunity board.
7. Add CLI under `ravi crm`.
8. Add `--include-crm` or default CRM summary to `ravi contacts profile`.

## Debugging

When CRM state looks wrong:

1. Inspect the current projection row.
2. Inspect `crm_events` for that entity.
3. Inspect linked `contact_events` if a contact is involved.
4. Inspect evidence ids: message, session event, task, artifact, or manual actor.
5. Confirm the issue is CRM state, not contact identity or access policy.

Useful future commands:

```bash
ravi crm contact <contact> --json
ravi crm events --contact <contact> --json
ravi crm next --json
ravi contacts profile <contact> --include-crm --json
```

## Migration Notes

Existing contact metadata can seed CRM rows:

- `profile.open_loops` -> `crm_tasks` or `crm_contact_profiles.next_action_summary`
- `profile.current_focus.*` -> `crm_facts` or opportunity notes
- `profile.relationship_context` -> `crm_contact_profiles.metadata_json`
- contact policy tags -> not automatically CRM lifecycle

Do not infer CRM account membership from group chat membership alone.

Do not infer CRM opportunity value from casual message text without explicit confirmation or low-confidence proposed fact.
