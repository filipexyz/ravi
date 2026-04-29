# Conversation Thread / WHY

## Rationale

Current raw message headers identify who sent a message, but they are too repetitive for multi-message turns. In a group chat, consecutive messages from the same person should read like one person holding the floor, not like unrelated packets.

The conversation thread feature adds a lightweight announcement layer:

- first speaker: starts the floor
- different speaker: transfers the floor
- system event: interrupts without taking the floor
- same speaker after system event: resumes the floor

This gives the agent enough context to reason naturally while keeping the transcript compact.

## Why This Belongs To Chat Semantics

The speaker is not a property of the runtime session alone. A session is the agent runtime container; the human actors come from chat participants and message actor metadata.

Placing the rule under `channels/chats` keeps it aligned with the existing identity model:

- chat participants are the canonical membership surface
- message/event actor metadata is authoritative for who said something
- sessions can have multiple participants
- raw channel ids remain provenance, not product-facing identity

## Why Text Annotation Plus Structured Context

The agent benefits from seeing a natural-language annotation because it helps interpret the conversation. Host tools and permission checks need structured identity because authorization cannot depend on parsing natural language.

Both are required:

- `speaker_annotation` is prompt UX
- `active_actor_context` is policy and routing data

## Calendar And Personal Resources

Individual calendars are personal resources. In a group chat, an agent must not get broad calendar visibility just because many people are present.

The current speaker is the safest default authority boundary:

- when Luis is speaking, the agent can see Luis's approved calendar surface
- when Rafa starts speaking, the active personal-resource scope switches to Rafa
- when a system event arrives, it does not create or expand personal-resource authority

Cross-person scheduling needs explicit authorization because "put it on Beltrano's calendar" from another speaker is not sufficient proof that Beltrano authorized access.

## Rejected Alternatives

- Repeat the full raw channel header on every inbound message. This preserves identity but makes the transcript noisy and less conversational.
- Use display names as identity. This conflicts with the identity graph rules and can bind the wrong person.
- Treat the session as having one primary human. This breaks groups, support rooms, and multi-contact sessions.
- Grant tools access to every participant in the chat. This is too broad for personal resources.
