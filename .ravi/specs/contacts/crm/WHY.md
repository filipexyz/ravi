# Why Contact CRM

Contacts already knows who a person or organization is across platform identities, and profile cards can summarize what Ravi knows.

That is not enough for CRM because relationship work needs operational objects:

- which relationship stage the contact is in
- who owns the relationship
- which account or opportunity the person belongs to
- what the next action is
- what was promised or decided
- what should happen automatically next

The main design decision is to keep CRM separate from contact policy.

`contact_policy.status` controls access to Ravi. CRM lifecycle controls relationship work. Mixing those two would make common cases ambiguous: a contact can be `allowed` and also `lead`, `waiting`, `at_risk`, `internal`, or `vendor`.

The second decision is to keep organizations anchored in contacts. The existing contacts spec says a canonical contact can be a person or organization. `crm_accounts` therefore wraps an org contact instead of becoming a competing identity model.

The third decision is to make current CRM tables projections over an append-only event ledger. This keeps agent writes auditable and lets us reject, supersede, or explain CRM state later.

The result is a CRM layer that can power dashboards and follow-ups without corrupting identity, routing, or channel abstractions.
