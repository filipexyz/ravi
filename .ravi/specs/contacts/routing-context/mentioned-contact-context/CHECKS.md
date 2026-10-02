# Mentioned Contact Context / CHECKS

- A WhatsApp group message with formal mention metadata MUST resolve the
  mentioned user to a canonical contact when a platform identity exists, and
  the prompt payload MUST carry `mentionedContactsContext`.
- Display-name-only mentions MUST NOT create CRM context.
- Agent-owned, unresolved and ambiguous mentions MUST be omitted.
- The rendered user prompt MUST NOT contain the CRM summaries, raw phone/LID/JID
  values or database ids.
- The context MUST NOT be worded as an event that requires a response.
- `bun test src/channels/inbound/pipeline-context.test.ts src/prompt-builder.test.ts`
  SHOULD pass after a change to mention context.
