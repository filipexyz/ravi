---
id: channels/presence
title: "Channel Presence"
kind: capability
domain: channels
capabilities:
  - presence
tags:
  - presence
applies_to:
owners:
status: active
normative: true
---

# Channel Presence

## Scope

This spec defines presence, typing and user-visible runtime status semantics for channels.

## Presence Model

`ChannelPresence` MUST represent:

- actor or instance subject
- chat/thread context when relevant
- state
- timestamp
- TTL or expiry when relevant
- source platform metadata

Supported states MAY include:

- online
- offline
- typing
- recording
- paused
- unavailable

## Runtime Status Projection

Agent runtime status is distinct from platform presence and delivery receipts. It represents what a session is doing from the user's point of view, such as thinking, using tools, rendering, sending, waiting, failed or complete.

User-visible runtime status MUST include:

- origin session id
- origin agent id when available
- channel id
- instance id
- chat id
- optional thread id
- state
- timestamp
- TTL or explicit terminal state
- status anchor

The default status anchor SHOULD be the latest visible outbound message emitted by the same session in the same chat/thread.

If no outbound message exists yet for that session and chat/thread, runtime status MUST use a chat/thread transient anchor or a draft outbound message when the platform supports it. It MUST NOT attach normal runtime status to the inbound user message that triggered the run.

When the agent emits an outbound message, active runtime status SHOULD be re-anchored to that outbound message so the visible status follows the agent response instead of the user's prompt.

Anchor resolution MUST be scoped by session and chat/thread. In a chat with multiple subscribed sessions, Ravi MUST NOT attach status to the last global bot message from another session.

Adapters MUST project the canonical anchor through the native semantics of each platform. If a platform API exposes only a thread-level status, the adapter MUST use the stable chat/thread identifier for that native status and MAY use the latest outbound message only for a separate message-level renderer such as a reaction.

## Rules

1. Presence MUST be capability-gated per platform and instance.
2. Presence events MUST NOT create or own sessions.
3. Outbound typing/presence MUST be policy-controlled.
4. Presence SHOULD expire by TTL unless the platform provides durable state.
5. Unsupported presence MUST degrade silently only when the capability matrix says it is unavailable.
6. Runtime status MUST expire by TTL or clear on a terminal state.
7. Runtime status MUST remain separate from delivery state even when both are rendered on the same outbound message.

## WhatsApp And Slack

WhatsApp typing/recording/presence behavior MUST be modeled separately from Slack presence because availability, scopes and semantics differ.

Slack assistant thread status is thread-scoped. The Slack adapter MUST call native assistant status APIs with the stable Slack thread timestamp (`threadId` or source/root message) and MUST NOT pass a latest outbound message id as the assistant `thread_ts`, because doing so creates independent status indicators for intermediate assistant messages.
