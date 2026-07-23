# Chat Model / CHECKS

## Checks

- A canonical chat MUST be able to bind to more than one Ravi agent session.
- Chat participants MUST be stored at chat scope; session participants MUST NOT
  overwrite the canonical chat membership list.
- A group, room, or thread MUST NOT be represented as a person contact.
- Prompt chat context MUST scope participants under `sourceChat` or
  `outputChat`, never a flat session-level `groupMembers` list for new code.
- Message and event metadata MUST preserve actor type plus contact, agent, or
  platform identity ids when known, while keeping raw Omni ids as provenance.
- `ravi specs get channels/chats --mode rules --json` MUST return the full
  inherited channels boundary.
