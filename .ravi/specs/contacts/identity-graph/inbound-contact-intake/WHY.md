# Why Inbound Contact Intake

## Decision

Create a canonical-first inbound contact intake layer.

The intake layer captures human contacts and their channel identities as soon as Ravi receives inbound channel messages, before CRM analysis and before agent routing decisions.

## Rationale

CRM is already conceptually above canonical contacts through `crm_contact_profiles.contact_id`.

The confusing part is not CRM creating a second contact. The confusing part is that inbound chat handling can store chat/session/router data without guaranteeing a canonical contact exists for the human who spoke.

For a CRM or relationship system, capture must precede analysis.

## Why Not Just SQL

SQL can repair old data and run imports, but ongoing intake needs runtime logic:

- channel and instance scoping
- Omni-resolved WhatsApp identity values
- route and policy boundaries
- idempotency by provider event/message ids
- audit event creation
- group-vs-human distinction

Doing this only with SQL would either miss runtime evidence or create unsafe merges.

## Why Per Instance

Different instances have different operating modes.

Some instances are CRM/business intake surfaces where every inbound human should be captured. Others may be personal, temporary, test, or privacy-sensitive surfaces where automatic contact creation should stay off.

Per-instance configuration lets Ravi register everything for SDE-style intake without forcing that behavior globally.

## Why CRM Stays Optional

The immediate requirement is "register who contacted us and keep the conversation evidence".

That is identity and chat storage, not CRM analysis.

CRM enrichment can be asynchronous: observers and agents can later decide lifecycle, opportunities, facts, activities, and next actions. Creating a contact must not wait for that work.

## Boundary

Canonical intake is a runtime boundary:

- add a single intake service
- write canonical records only
- treat old data import as a one-time migration concern
- keep reads on `contacts`, `platform_identities`, and `contact_policies`
