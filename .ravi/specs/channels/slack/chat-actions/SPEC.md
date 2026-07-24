---
id: channels/slack/chat-actions
title: "Slack Chat Actions"
kind: feature
domain: channels
capability: slack
feature: chat-actions
capabilities:
  - slack
  - chat-actions
  - native-channel
tags:
  - slack
  - messages
  - reactions
  - media
applies_to:
  - src/channels/slack/client.ts
  - src/channels/slack/socket-mode.ts
  - src/channels/outbound-consumer.ts
  - src/cli/commands/sessions.ts
  - src/cli/commands/react.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Slack Chat Actions

## Native Matrix

- `message.edit` MUST use `chat.update`, require `chat:write`, and target a
  normal message authored by the configured bot.
- `message.delete` MUST use `chat.delete`, require `chat:write`, and target a
  message authored by the configured bot.
- `message.react` MUST use `reactions.add` or `reactions.remove` and require
  `reactions:write`.
- `media.send` MUST use the external upload flow and require `files:write`.
- `sticker.send` MUST be `unavailable` with `unsupported_channel`.
- `message.reply` MUST remain `planned` until a canonical quoted-reply command
  exists. Normal Slack thread delivery is not the same action.

## Invariants

- Native Slack chat actions MUST NOT resolve an Omni instance id.
- A missing native executor MUST fail explicitly.
- Edit, delete and reaction requests MUST use the durable channel runner.
- `media.send` MAY remain provider-confirmed synchronous while its input is a
  local file path; it MUST NOT report success before Slack completes the
  upload.
- Provider errors such as `missing_scope`, `cant_update_message`,
  `cant_delete_message`, `message_not_found` and rate limits MUST remain
  observable.
- Ephemeral messages MUST NOT be offered as editable normal messages.
- Canonical edit/delete state MUST be updated only after Slack confirms the
  operation.
- Thread and channel ids MUST remain separate from the message timestamp.

## Boundary With Slack Operations

`channels/slack/operations` owns direct workspace/operator commands under
`ravi slack` and their dry-run behavior.

This feature owns context-bound actions discovered through a Ravi session.
Invoking a session action is the explicit execution request; it does not add a
second `--execute` flag.
