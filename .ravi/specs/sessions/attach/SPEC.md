---
id: sessions/attach
title: Session Attach
kind: capability
domain: sessions
capabilities:
  - attach
  - multi-surface-reply
tags:
  - sessions
  - chats
  - routing
applies_to:
  - src/router/sessions.ts
  - src/router/router-db.ts
  - src/runtime/delivery-queue.ts
  - src/runtime/session-dispatcher.ts
  - src/runtime/session-output-target.ts
  - src/runtime/session-surface-hint.ts
  - src/cli/commands/sessions.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Session Attach

## Intent

One session may participate in multiple chats while keeping one shared history.
Each inbound turn replies to the chat or thread that produced it.

## Model

A `session_chat_subscription` attaches one canonical chat to one session.

- One session MAY have many active subscriptions across channels.
- One canonical chat MUST belong to at most one active session.
- One active subscription MAY be selected as the session's default output.
- A thread is a distinct reply surface from its parent chat and from other
  threads.

Routes and attachments solve different problems:

- a route selects the agent/session that receives inbound traffic;
- an attachment records that the chat participates in that session.

## Reply Resolution

For every physical provider turn, the runtime MUST bind one immutable reply
surface when the turn starts.

1. An inbound turn replies to its attached source chat or thread.
2. A turn with no inbound source replies to the default output attachment.
3. An inbound source that is not attached MUST fail closed. It MUST NOT fall
   back to the default output.
4. A source-less turn with no default output MUST fail closed.

The default output is only a fallback for proactive and other source-less
turns. It never overrides an inbound source.

## Turn Isolation

A provider session has one ordered transcript, so its turns MUST remain
serialized.

- Messages from different reply surfaces MUST NOT share one physical turn.
- A message from another surface MUST NOT steer or interrupt the active turn.
- It remains queued in FIFO order and starts after the active turn completes.
- Messages from the same surface MAY be coalesced or steered when their normal
  delivery-barrier and authority rules allow it.
- Provider-neutral channel turn envelopes remain isolated one per physical
  turn.
- `currentSource` MUST only be assigned at physical turn start. Queueing,
  waking, or steering MUST NOT replace it.
- The external reply target MUST be resolved once at physical turn start.
  Subscription changes during the turn MUST NOT redirect that turn.

## Prompt Contract

The dispatcher adds exactly one short English instruction to every new logical
prompt:

```text
[session surface] This turn came from a Slack chat. A normal reply returns there.
```

For a thread, it says `Slack thread`. For a source-less turn, it says that the
session default will be used when one is available.

The instruction MUST NOT include session names, chat ids, subscription lists,
roles, database fields, or routing commands. It is added centrally so every
channel uses the same contract, and it MUST remain idempotent across durable
replay.

## CLI

```bash
ravi sessions attach <session> --chat <chat-id> [--reason "..."]
ravi sessions detach <session> --chat <chat-id>
ravi sessions subscriptions <session>
```

- `attach` adds/reactivates the subscription and selects it as the default
  output.
- `detach` removes the subscription and clears it as default.
- `subscriptions` lists active chats and the default marker.

There is no speech mode. `mute`, `unmute`, and `focus` are not part of this
capability.

`@@SILENT@@` suppresses only the current response. It does not modify session
wiring.

## Persistence

- Resetting provider continuity MUST preserve chat subscriptions.
- Deleting a session MUST cascade to its subscriptions.
- Existing databases may retain obsolete speech columns; runtime and CLI code
  MUST ignore them. New schemas do not create them.

## Validation

```bash
bun test src/router/session-attach.test.ts src/runtime/session-output-target.test.ts
bun test src/runtime/delivery-queue.test.ts src/runtime/session-dispatcher.test.ts
bun test src/runtime/session-surface-hint.test.ts src/omni/consumer-context.test.ts
bun test src/channels/slack/socket-mode.test.ts src/channels/slack/thread-lifecycle.test.ts
```

Regression coverage MUST include:

- Slack active, WhatsApp queued, then one reply to each source in order;
- two Slack threads remaining separate;
- source-less output using the default attachment;
- an unattached inbound source failing closed;
- replay adding the surface instruction only once.

## Failure Modes

- Mutating `currentSource` when a later message arrives.
- Resolving subscriptions again when a response is emitted.
- Combining messages from different chats before provider delivery.
- Letting a different surface use native steer or host interruption.
- Sending an inbound turn to the default output.
- Implementing the surface instruction in one channel adapter instead of the
  central dispatcher.
