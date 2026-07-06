---
id: channels/slack/presence
title: "Slack Native Presence"
kind: feature
domain: channels
capability: slack
feature: presence
capabilities:
  - slack
  - presence
tags:
  - slack
  - assistant
  - presence
  - socket-mode
applies_to:
  - src/channels/slack/
  - src/channels/presence-consumer.ts
  - src/gateway.ts
owners:
  - dev
status: active
normative: true
---

# Slack Native Presence

## Intent

Slack presence MUST use native Slack agent UI when the workspace and token support it.

Emoji reactions MAY exist as a compatibility fallback, but they MUST NOT be the primary signal for "agent is working" in Slack. The native Slack state is less noisy, expires automatically, and is attached to the Slack conversation surface itself.

## Invariants

- Ravi MUST call `assistant.threads.setStatus` when native Slack presence is enabled.
- Active presence MUST set a non-empty status on the Slack `channel_id` and `thread_ts`.
- Inactive presence MUST clear the Slack status by sending an empty status string for the same `channel_id` and `thread_ts`.
- The status target MUST prefer `MessageTarget.threadId` for real Slack thread turns.
- For root-channel turns, the status target MUST prefer `MessageTarget.statusAnchorMessageId` when delivery has produced a visible outbound message, and MAY fall back to `MessageTarget.sourceMessageId` only before the first outbound anchor exists.
- A missing Slack timestamp MUST skip native presence instead of sending an invalid Slack API request.
- Emoji reaction presence MUST be explicit opt-in only, not automatic fallback.
- Slack API errors from native status MUST NOT automatically fall back to reaction presence.
- Legacy reaction cleanup MAY be performed by an explicit maintenance operation, but normal native status clear MUST NOT render or mutate reaction state by default.
- Before activating a new Slack status for a session, Ravi MUST clear recent prior status anchors known for that same session and chat/thread. This cleanup MUST be idempotent because interrupted turns and compacted runtime turns can emit terminal clears before Slack has visibly removed the old status.
- After delivery reanchors active status to an outbound message, later runtime activity for the same session and chat/thread MUST renew that outbound anchor. It MUST NOT move status back to an inbound user message while a matching outbound anchor is known.
- Terminal runtime events MUST clear the active Slack status without forgetting the last outbound anchor. A delivered outbound message that is observed after terminal cleanup MUST still become the preferred anchor for the next runtime activity in the same session and chat/thread.
- A new inbound turn MAY use the inbound source message only when Ravi has no matching outbound anchor yet, or when the turn is for a different chat/thread surface.
- Channel credentials and tokens MUST remain inside the native Slack adapter; runtime agents MUST NOT receive token values.

## Runtime Policy

Default behavior:

```text
native assistant status: enabled
reaction presence: off
status text: "is working..."
```

Environment controls:

- `RAVI_SLACK_ASSISTANT_STATUS=0|false|off|no` disables native assistant status.
- `RAVI_SLACK_ASSISTANT_STATUS_TEXT=<text>` overrides the status text.
- `RAVI_SLACK_REACTION_PRESENCE=always|off` controls explicit reaction behavior.
- `RAVI_SLACK_WORKING_REACTION=<emoji-name>` overrides the explicit reaction name.

## Slack Semantics

`assistant.threads.setStatus` is thread-scoped. For normal Slack thread turns, Ravi MUST use the thread timestamp. For root messages, Ravi MUST move the status to the latest visible outbound message timestamp as deliveries happen, clearing prior root anchors first. Delivery policy MUST still decide whether the final answer is posted to the channel root or thread.

Future streaming work SHOULD use the Slack `chat.startStream`, `chat.appendStream`, and `chat.stopStream` APIs for incremental agent responses. This spec only covers native working presence.

## Acceptance Criteria

- A Slack turn emits active native status before long-running work.
- A terminal runtime event clears native status.
- If native status fails, Ravi does not render reaction fallback.
- Presence diagnostics record whether native status was used or failed.
