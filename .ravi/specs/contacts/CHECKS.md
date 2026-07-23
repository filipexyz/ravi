# Contacts / CHECKS

## Checks

- A canonical contact MUST represent a real person or organization, not a raw
  provider id.
- Platform identities MUST be scoped by channel and instance and linked to
  either a contact or an agent.
- Ravi agents MUST remain agents; agent-owned platform identities MUST NOT be
  merged into human contacts.
- Chats, groups, rooms, and threads MUST NOT be modeled as contacts.
- Contact discovery, reads, timeline, profile, and CRM projections MUST be
  authorized before disclosure.
- `bun test src/contacts.identity-model.test.ts src/cli/commands/contacts.test.ts`
  SHOULD pass after changing contact identity or CLI behavior.
