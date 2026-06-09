---
id: channels/mentions
title: Channel Mentions
kind: capability
domain: channels
capability: mentions
tags:
  - channels
  - omni
  - whatsapp
  - mentions
applies_to:
  - src/omni/mentions.ts
  - src/omni/consumer.ts
  - src/omni/sender.ts
  - src/gateway.ts
  - src/cli/commands/group.ts
owners:
  - dev
status: draft
normative: true
---

# Channel Mentions

## Intent

Ravi can send native channel mentions while keeping Omni as the transport adapter and Ravi as the semantic owner of chats, participants, contacts, sessions, and outbound intent.

## WhatsApp Outbound Contract

- WhatsApp mentions MUST be delivered to Omni as both:
  - text containing a human-readable visible placeholder such as `@<display-name>` when Ravi knows a safe display label for the participant
  - `mentions: [{ id: "<jid-or-platform-user-id>", type: "user" }]`
- Ravi MUST NOT introduce WhatsApp LIDs, JIDs, bare phone-like ids, or other raw channel identifiers into user-visible outbound text while resolving automatic inline mentions.
- When Ravi has a trusted WhatsApp LID-to-phone mapping for a participant, outbound mention delivery SHOULD use the phone JID as the native mention id and keep the LID/raw id as match provenance. The visible text still SHOULD use the participant's safe display label.
- When no trusted phone mapping exists, the mention `id` MAY preserve the strongest provider identity available from Omni, including WhatsApp LID JIDs such as `<lid-number>@lid`.
- When no safe display label exists for an automatic inline mention target, Ravi MUST fail closed: leave the visible text unchanged and MUST NOT attach native mention metadata for that alias.
- Operator-supplied explicit raw targets MAY still be accepted for CLI/diagnostic sends when no participant display label is available. That exception MUST NOT be used by runtime agents as a default rendering strategy.
- Ravi MUST NOT rely on the Omni CLI or generated SDK types for this MVP; the Omni API `/api/v2/messages/send` is the transport contract.
- Gateway direct sends MUST pass a provided structured `mentions` array through to Omni without reconstructing or dropping it.

## Resolution Rules

- Name-to-mention resolution MUST be scoped to the target chat/group participants.
- Automatic outbound inline mention resolution MUST use the final output chat participants, not the inbound source chat participants, whenever source and output differ.
- Inbound mention rendering MAY use source chat metadata because it is explaining the message that arrived from that chat.
- A session-level participant list MUST NOT be used for outbound mention resolution. The resolver MUST receive a chat-scoped participant set.
- Participant metadata from Omni MAY be used as the transport source for `displayName -> platformUserId/JID` resolution.
- Chat participant metadata MAY enrich Omni group members with trusted normalized phone aliases discovered from inbound provider mappings.
- Raw JID, LID, and phone-like targets MAY be accepted as explicit mention targets for operator/CLI sends, but automatic runtime output SHOULD prefer names and MUST NOT synthesize raw visible placeholders.
- Ambiguous explicit display-name matches MUST fail closed and ask for a JID/phone instead of guessing.
- Automatic inline `@name` placeholders MUST only resolve against exact participant aliases in the target chat/group.
- Automatic inline matching MAY use the full display name, a unique exact first-name alias, accent-insensitive spelling, or an exact participant numeric id.
- Automatic inline matching MUST NOT resolve prefixes or substrings. For example, `@Nomealgo` MUST NOT match participant `Nome`, and `@AQUIalgo` MUST NOT match participant `AQUI`.
- Automatic numeric id matching MUST only resolve when the full numeric token matches a participant identifier with a plausible WhatsApp id length.
- Automatic numeric id matching MUST only attach native mention metadata when the matched participant has a safe display label that can replace the raw visible token.
- Display name matching MUST NOT create or merge contacts. It is only a local addressing hint for the current send operation.
- If automatic inline resolution cannot prove that the alias belongs to the target output chat, Ravi MUST leave the visible text unchanged and MUST NOT attach a native mention for that alias.
- Group/member prompt context MUST NOT expose raw participant identifiers as member labels. Participants without a safe display label SHOULD be omitted from human-readable member lists while their raw ids remain preserved as provenance in transport caches and structured records.

## Multi-Chat Sessions

A single runtime session MAY receive input from one chat while its external output is attached to another chat.

For that case:

- The agent-facing prompt SHOULD explain both `sourceChat` and `outputChat` using `channels/chats` chat-context rules.
- Inbound normalized text and quoted-message context are interpreted against `sourceChat`.
- Outbound native mentions are resolved against `outputChat`.
- If `sourceChat` and `outputChat` are the same canonical chat, the same participant set MAY be reused.
- If `sourceChat` and `outputChat` differ and output participants are unavailable, automatic outbound mention resolution MUST fail closed by sending plain text without native mention metadata.
- Specs and tests MUST use placeholders such as `<display-name>` and `<chat-id>` instead of real person or group names.

## Inbound Rendering

- Inbound WhatsApp text MAY arrive from Omni with visible numeric placeholders such as `@<lid-number>`.
- Ravi SHOULD normalize those placeholders to readable names for agent-facing prompt/history when Omni raw payload includes matching `mentionedContacts` or resolvable `mentionedJids`.
- Inbound normalization MUST only change Ravi's agent-facing text representation. The original Omni `rawPayload`, `mentionedJids`, and provider ids MUST remain preserved as raw provenance.
- Ravi MUST NOT infer canonical contact identity from mention display names. Mention name rendering is a presentation transform only.

## Boundaries

- Contacts and platform identities remain the canonical identity model.
- Chat participants remain scoped to chats.
- Raw provider identifiers MUST remain transport provenance, not product-level contact identity.
- Full Omni/Ravi normalized mention tables are a later improvement; the MVP can render agent-facing names from Omni raw mention metadata first.

## Validation

- `bun test src/omni/mentions.test.ts src/omni/sender.test.ts src/omni/group-metadata-cache.test.ts src/gateway-session-trace.test.ts src/cli/commands/channels-json.test.ts`
- `bunx biome check src/omni/mentions.ts src/omni/mentions.test.ts src/omni/sender.ts src/omni/sender.test.ts src/gateway.ts src/cli/commands/group.ts src/omni/index.ts`
- `bun run typecheck`
- `bun run build`
