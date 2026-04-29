---
id: channels/chats/conversation-thread
title: "Conversation Thread"
kind: feature
domain: channels
capability: chats
feature: conversation-thread
capabilities:
  - chats
tags:
  - channels
  - chats
  - participants
  - prompt-context
  - permissions
applies_to:
  - src/omni/consumer.ts
  - src/runtime/message-types.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/runtime-request-builder.ts
  - src/router/router-db.ts
owners:
  - dev
status: active
normative: true
---

# Conversation Thread

## Intent

Conversation thread state makes multi-participant chat turns legible to the agent without making the agent parse raw channel headers.

When a human participant speaks, Ravi SHOULD inject an agent-visible conversation annotation that announces who has the conversational floor. The annotation behaves like existing message headers and system observation banners: it is prompt context, not user-authored text.

The same resolved actor context MUST drive identity-scoped tools and permissions. A personal resource such as an individual calendar is visible only for the current speaking actor unless a separate permission grant explicitly allows broader access.

## Definitions

- `conversation_thread`: the ordered sequence of human, agent, and system prompt items for one runtime session bound to a chat.
- `speaker`: the resolved actor currently producing human-authored chat messages.
- `floor_actor`: the contact/platform identity that currently has the conversational floor.
- `system_interruption`: a system-originated prompt item, notification, task update, daemon notice, trigger, or recovery notice that interrupts the prompt sequence but does not take the human conversational floor.
- `speaker_annotation`: synthetic prompt text injected by Ravi to announce floor transitions.
- `active_actor_context`: structured identity metadata for the current speaker, derived from message actor metadata.

## Invariants

- Ravi MUST derive speaker identity from resolved actor metadata: `actor_type`, `contact_id`, `agent_id`, `platform_identity_id`, `chat_id`, and raw channel provenance when available.
- Ravi MUST NOT infer speaker identity from display name alone.
- A speaker annotation MUST be generated when a human/contact actor first speaks in a conversation thread with no current floor actor.
- A speaker annotation MUST be generated when the human/contact actor changes from the previous floor actor.
- Ravi MUST NOT repeat the speaker annotation for contiguous messages from the same human/contact actor.
- A system interruption MUST NOT replace the current floor actor.
- After a system interruption, the next message from the same floor actor SHOULD receive a continuation annotation.
- If a different human/contact actor speaks after a system interruption, Ravi MUST generate a speaker-switch annotation for the new actor instead of a continuation annotation.
- Speaker annotations MUST be distinguishable from user-authored message content.
- Speaker annotations SHOULD be compact and announcement-like. They SHOULD NOT repeat the full raw channel message header for every message.
- The active actor context MUST be made available to host tools and permission checks out of band. Tools MUST NOT scrape the human-readable annotation to decide identity.
- Personal-resource tools MUST scope visibility and mutation to the active speaking contact/platform identity by default.
- When the active speaker is unresolved, `system`, `agent`, or `unknown`, personal-resource tools MUST deny per-person access unless an explicit higher-scope authorization is present.
- A group chat MUST NOT grant access to all participant calendars merely because those participants are in the chat.
- Cross-person operations MUST require explicit target authorization separate from the current speaker context.

## Annotation Semantics

The exact copy MAY be localized, but the semantic transitions are fixed:

- first human speaker: `Fulano começou a falar`
- speaker switch: `Agora Beltrano está com a palavra`
- same speaker after system interruption: `Continuando com Beltrano`

Example prompt sequence:

```text
[Conversation] Luis Filipe começou a falar.
Luis Filipe: vamos marcar amanhã

Luis Filipe: de tarde melhor

[System] Inform: Artifact completed.

[Conversation] Continuando com Luis Filipe.
Luis Filipe: coloca no meu calendário

[Conversation] Agora Rafa está com a palavra.
Rafa: pra mim pode ser às 16h
```

## State Model

Ravi SHOULD maintain conversation floor state per runtime session:

- `session_key`
- `chat_id`
- `floor_actor_type`
- `floor_contact_id`
- `floor_agent_id`
- `floor_platform_identity_id`
- `floor_display_name`
- `last_prompt_actor_type`
- `last_prompt_was_system_interruption`
- `updated_at`

The state MAY be persisted or reconstructed from recent session events. The implementation MUST preserve enough event metadata to debug why a transition annotation was or was not injected.

## Prompt Envelope Contract

Inbound prompt construction SHOULD carry both:

- a human-readable `speaker_annotation` when a transition occurs
- structured `active_actor_context` for host permissions

`active_actor_context` SHOULD include:

- `actor_type`
- `contact_id`
- `agent_id`
- `platform_identity_id`
- `chat_id`
- `display_name`
- `source_channel`
- `source_account_id`
- raw sender ids as provenance

The annotation is for agent comprehension. The structured context is for authorization and tool routing.

## Permission Contract

Personal-resource tools such as calendar tools MUST evaluate access against `active_actor_context`.

Default behavior:

- current speaker is a resolved contact: allow that contact's approved personal resources only
- current speaker is unresolved: deny personal resources and ask for identity resolution or explicit authorization
- current prompt actor is `system`: continue the previous floor actor only for conversation continuity, but do not let the system event itself create new personal-resource authority
- current speaker asks for another person's resource: deny or require explicit target authorization unless that other person is also independently authorized

## Boundaries

This feature belongs to Ravi's semantic layer.

Omni supplies raw chat/sender facts and transport provenance. Ravi owns actor resolution, conversation floor state, prompt annotations, and permission scoping.

The feature MUST work with chats and actors, not raw WhatsApp JIDs, phone numbers, or group ids as the primary model.

## Validation

- `bun test src/omni/ src/runtime/ src/gateway-session-trace.test.ts`
- Add targeted tests for speaker annotation transitions before implementation is considered complete.
- Add targeted tests for personal-resource permission scoping before enabling calendar access.

## Known Failure Modes

- Repeating full WhatsApp-style headers on every message and making the transcript noisy.
- Treating a system notification as the new speaker and losing the previous floor actor.
- Granting a group agent visibility into every participant calendar.
- Letting a user access another participant's personal resources just because they mentioned that participant.
- Inferring identity from display name and binding the wrong personal resource.
- Giving tools only the text annotation and forcing them to parse natural language for authorization.
