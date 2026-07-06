---
id: channels/messages
title: "Channel Messages"
kind: capability
domain: channels
capabilities:
  - messages
tags:
  - messages
applies_to:
owners:
status: active
normative: true
---

# Channel Messages

## Scope

This spec defines canonical message shape and content semantics.

## Message Requirements

`ChannelMessage` MUST include:

- Ravi message id
- channel id
- instance id
- chat id
- optional thread id
- actor id
- platform identity reference
- timestamp
- direction: inbound, outbound or system
- content
- attachments
- mentions
- reply/quote references
- reactions summary or references
- delivery state reference
- raw platform metadata when retained

## Content Kinds

`ChannelMessageContent` MUST support:

- text
- markdown
- rich_text
- image
- audio
- video
- file
- sticker
- location
- contact_card
- interactive
- card
- system
- unsupported

Unsupported content MUST preserve enough metadata for audit and future parser improvement.

## Edit/Delete Rules

Message edits and deletes MUST be represented as state transitions or events tied to the canonical message id and platform identity. They MUST NOT be treated as unrelated messages.

## Status Anchor Rules

Outbound `ChannelMessage` records emitted by an agent/session SHOULD be eligible as anchors for user-visible runtime status for that same session in the same chat/thread.

Inbound user messages MUST NOT be the default anchor for agent runtime status. If a run starts before the agent has any outbound message in that chat/thread, the status MUST be represented as a chat/thread transient status or as a draft/placeholder outbound message when the platform capability allows it.

When a new outbound message is created for the same origin session and chat/thread, active runtime status SHOULD move to that outbound message or resolve through `ChannelStatusAnchor` to that message.

## Reply And Mention Rules

Replies, quotes and mentions MUST resolve to canonical references when possible and preserve platform references when not.
