# Contact Identity Graph / CHECKS

- `channel + instance_id + platform_user_id` MUST be unique, and a platform
  identity MUST be owned by exactly one contact or one agent.
- A WhatsApp group MUST resolve as a chat, never as a contact.
- An agent's channel account MUST be an agent-owned platform identity and MUST
  NOT be merged into a human contact.
- Weak evidence (same display name, similar avatar) MUST NOT auto-merge
  contacts; it SHOULD only create candidates.
- Merge and unlink MUST each write an audit event.
- `ravi contacts get <any-known-id>` SHOULD return the same canonical contact
  for every linked identity.
- `bun test src/contacts.identity-model.test.ts` SHOULD pass after a change to
  identity resolution.
