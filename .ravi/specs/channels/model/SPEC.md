---
id: channels/model
title: "Channels Model"
kind: capability
domain: channels
capabilities:
  - model
tags:
  - model
applies_to:
owners:
status: active
normative: true
---

# Channels Model

## Scope

This spec defines the canonical data model used by Ravi channels and generated SDKs.

## Required Entities

The model MUST define:

- `Channel`
- `ChannelInstance`
- `ChannelConnectionLifecycle`
- `ChannelChat`
- `ChannelThread`
- `ChannelMessage`
- `ChannelMessageContent`
- `ChannelActor`
- `PlatformIdentity`
- `ChannelAttachment`
- `ChannelMention`
- `ChannelReaction`
- `ChannelPresence`
- `ChannelStatusAnchor`
- `ChannelCapabilityMatrix`
- `ChannelCredentialRequirements`
- `ChatActionDescriptor`
- `ChatActionAvailability`
- `ChatActionRequest`
- `ChatActionResult`
- `ChatActionUnavailableReason`
- `OutboundRequest`
- `DeliveryResult`

## Identity Rules

1. Canonical IDs MUST be stable inside Ravi.
2. Platform IDs MUST be preserved separately as `PlatformIdentity`.
3. Platform raw payloads MAY be retained for audit/debug, but canonical behavior MUST NOT depend on ad hoc raw payload reads.
4. A Ravi actor MAY map to multiple platform identities over time.
5. A platform identity MUST include channel, instance and platform-specific subject.

## Conversation Rules

1. `ChannelChat` is the platform conversation container: WhatsApp group/DM, Slack channel/DM/MPIM, or equivalent.
2. `ChannelThread` is an optional nested conversation scope inside a chat.
3. `session` is not part of the channel model. It belongs to the runtime/router model.
4. Subscriptions connect chats/threads to sessions. They MUST be many-to-many.

## Status Anchor Rules

`ChannelStatusAnchor` MUST represent where user-visible runtime status for an agent/session is rendered in a channel surface.

A status anchor MUST include:

- channel id
- instance id
- chat id
- optional thread id
- origin session id
- origin agent id when available
- anchor kind
- canonical message id when anchored to a message
- platform message identity when available
- timestamp

Supported anchor kinds MUST include:

- last_outbound_message
- chat_thread_transient
- draft_outbound_message
- none

The default anchor for agent runtime status SHOULD be the latest outbound `ChannelMessage` emitted by the same session in the same chat/thread. It MUST NOT be the inbound user message that triggered the run, except in explicit debug views.

## Lifecycle Rules

`ChannelInstance` MUST carry lifecycle state independently from agent sessions:

- configured
- connecting
- connected
- degraded
- disconnected
- reconnecting
- logged_out
- disabled
- deleted

Lifecycle transitions MUST be observable and SHOULD include reason, timestamp and source.

## Compatibility Rules

The model MUST be able to represent current Omni inbound/outbound behavior without making Omni fields canonical. When a current behavior cannot be represented, the model spec MUST be updated before implementation.
