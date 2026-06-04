---
id: contacts/routing-context/mentioned-contact-context
title: Mentioned Contact Context
kind: feature
domain: contacts
capability: routing-context
feature: mentioned-contact-context
tags:
  - contacts
  - crm
  - channels
  - mentions
  - runtime
  - prompt
applies_to:
  - src/contacts.ts
  - src/omni/mentions.ts
  - src/omni/consumer.ts
  - src/runtime/message-types.ts
  - src/prompt-builder.ts
owners:
  - dev
status: draft
normative: true
---

# Mentioned Contact Context

## Intent

When a group message formally mentions a person, Ravi should resolve that mention to the canonical contact graph and attach compact structured CRM/contact metadata to the current turn.

This exists so the runtime can understand who is being discussed without forcing every agent to query CRM manually or polluting the visible user prompt.

## Contract

- The transport mention is the trigger. V1 MUST use formal channel mention metadata such as WhatsApp `mentionedJids` or `mentionedContacts`.
- Ravi MUST NOT infer a mentioned contact from display name text alone.
- Mention resolution MUST flow through platform identity and then canonical contact:

```text
raw channel mention id
  -> platform_identity
  -> contact
  -> CRM/contact snapshot
  -> structured per-message runtime context
```

- If the mentioned identity is unresolved, ambiguous, or owned by an agent instead of a contact, Ravi MUST omit CRM context for that mention.
- The mention metadata MUST NOT be rendered into the user-visible prompt envelope by default.
- The mention metadata MUST be structured runtime context. It MUST NOT expose raw provider ids, contact ids, or low-level database fields to the provider-facing prompt.
- The context is ephemeral per inbound message. It MUST be attached to the current prompt payload/runtime context, not to long-lived session/channel context.
- CRM/contact values MUST be treated as untrusted data. User-controlled values such as names, tags, task titles, opportunities, and facts MUST be sanitized/quoted and framed as data, not instructions.
- The context is advisory. It helps interpret the current message; it does not grant permission to expose private CRM details in the external reply.
- Mention context MUST NOT be rendered as a conversational event. It MUST NOT tell the agent that "someone mentioned you", "someone was mentioned", or otherwise imply that a response is required because of the mention.
- Mention context MUST NOT be treated as a wake-up signal. The agent should still follow normal group silence/relevance rules unless the actual user message asks for help.

## Runtime Shape

The structured context SHOULD be compact:

```ts
{
  mentionedContactsContext: [
    {
      displayName: "<Pessoa>",
      summaryLines: [
        "Conta associada: \"<conta>\".",
        "Próxima ação no CRM: \"<ação>\"."
      ]
    }
  ]
}
```

Rules:

- Use one compact item per resolved contact.
- Keep each contact bounded to a small number of high-signal facts.
- Keep instructions about how to use this metadata in stable system rules or adapter code, not repeated in every inbound message.
- Avoid section titles or wording that make the metadata look like external chat content.
- Prefer current CRM projections over scanning raw chat history.
- Prefer confirmed facts and current next actions over old timeline noise.
- Mention unresolved people nowhere in this section.

## Data Sources

The briefing MAY use:

- canonical contact display name
- contact policy tags and interaction count
- CRM lifecycle, relationship health, priority, persona, buying role, next action
- primary account/opportunity names
- open opportunities and open tasks
- confirmed CRM facts
- recent contact timeline events when they are high-signal

It MUST NOT include:

- full raw message history
- raw phone, LID, JID, email, contact id, platform identity id, or database ids
- credentials, tokens, private implementation metadata, or unrelated session context
- facts derived only from display-name matching

## Security And Privacy

- The metadata is internal runtime context only.
- Agents MAY use the context to decide how to respond, but MUST NOT repeat internal CRM details externally unless the user explicitly asks or the detail is clearly necessary.
- Agents MUST NOT repeat metadata keys, wrappers, or CRM lines into the external chat.
- Context MUST remain scoped to the current inbound chat and current mentioned contacts.
- Mentioning a person MUST NOT grant access to that person's private resources, files, calendar, or unrelated sessions.

## Acceptance Criteria

- A WhatsApp group message with provider mention metadata resolves the mentioned user to a canonical contact when a platform identity exists.
- The prompt payload context includes structured `mentionedContactsContext`.
- The rendered user prompt envelope does not contain CRM mention summaries by default.
- The rendered prompt does not contain `Pessoas Mencionadas`, `foi mencionado nesta mensagem`, or wording that turns the metadata into a required-response event.
- Display-name-only mentions do not create CRM context.
- Agent-owned identities and unresolved mentions are omitted.
