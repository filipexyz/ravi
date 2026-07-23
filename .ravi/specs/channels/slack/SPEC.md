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
- Slack Block Kit operations and interaction events MUST follow `channels/slack/block-kit`.
- Slack topology MUST follow `channels/slack/topology`.
- Slack thread session forks MUST follow `channels/slack/threads`.
- Slack topology MUST report channels, Ravi routes, Ravi sessions and inbound policy gates.
- Slack custom sidebar sections MUST NOT be represented as native Ravi topology until Ravi has a credential path that can read them correctly.
- New Slack-facing skills SHOULD use native Slack operations first; Omni-backed Slack behavior is migration compatibility only.
