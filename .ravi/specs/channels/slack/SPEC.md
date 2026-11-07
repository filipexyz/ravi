---
id: channels/slack
title: "Slack Native Channel"
kind: capability
domain: channels
capabilities:
  - slack
  - native-channel
tags:
  - slack
  - socket-mode
  - routes
  - sessions
status: active
normative: true
---

# Slack Native Channel

Slack is a native Ravi channel, not an Omni-owned semantic surface.

## Invariants

- Slack adapter lifecycle rules live in `channels/adapters/slack`.
- Slack workspace operations MUST follow `channels/slack/operations`.
- Context-bound Slack chat actions MUST follow `channels/slack/chat-actions`.
- Slack Block Kit operations and interaction events MUST follow `channels/slack/block-kit`.
- Slack permission approval buttons MUST follow `channels/slack/approval`.
- Slack topology MUST follow `channels/slack/topology`.
- Slack thread session forks MUST follow `channels/slack/threads`.
- Slack topology MUST report channels, Ravi routes, Ravi sessions and inbound policy gates.
- Slack custom sidebar sections MUST NOT be represented as native Ravi topology until Ravi has a credential path that can read them correctly.
- New Slack-facing skills SHOULD use native Slack operations first; Omni-backed Slack behavior is migration compatibility only.

## Inbound Message Content

- Inbound normalization MUST preserve the complete visible text of supported Slack blocks, in message order. A top-level `text` notification fallback MUST NOT replace the body of an otherwise readable block message.
- Supported text blocks are `markdown`, `header`, and `section` (including section fields, without accessories); non-text dividers MAY be ignored. If any block cannot be interpreted safely, normalization MUST use the original top-level `text` rather than present a partial block extraction as complete.
- Normalization MUST choose one representation. It MUST NOT concatenate a notification fallback with its corresponding block body, duplicate text, or use block metadata, action values, or hidden fields as message content.
- Readable blocks without top-level `text` MUST still produce inbound content. Empty or unsupported blocks MUST preserve the existing text fallback and empty-message handling.
- This content rule applies equally to human and bot senders. It does not change structural eligibility, sender identity, authorization, or channel policy.
