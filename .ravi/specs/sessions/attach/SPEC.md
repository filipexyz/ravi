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
4. A source-less turn with no default output MUST fail closed for *chat*
   delivery. It MUST NOT invent a chat `.response` sink.

CLI-only `sessions send` (no `--channel`/`--to`, no inbound chat, named
session) is **not** a source-less attach turn. The waiting CLI is the
destination. After `turn.complete`, `sessions send -w` MUST return this
turn's assistant transcript row (persist may lag). Missing chat delivery
is not empty success when that transcript exists.

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

Inbound chat turns (WhatsApp, Slack, or another attached source that produced
this turn) receive exactly one short English instruction on the persisted
user prompt:

```text
[session surface] This turn came from a Slack chat. A normal reply returns there.
```

For a thread, it says `Slack thread`. The instruction MUST NOT include session
names, chat ids, subscription lists, roles, database fields, or routing
commands. It is added centrally so every channel uses the same contract, and
it MUST remain idempotent across durable replay.

Operator CLI-only and HTTP/user `sessions.send` MUST persist and dispatch the
raw user text. Honor `--raw`. The dispatcher MUST NOT prefix
`[session surface]` onto that `user.text` / `prompt.prompt`. Leftover
`lastChannel` on a session-relay send is not an inbound chat turn.

HTTP operator send (`transport: "gateway"`, no `callerSessionKey`) is neither
a waiting CLI nor a source-less attach turn. Do not write "waiting CLI" or
"no inbound chat" into that user row.

If the model still needs a surface instruction for an operator turn, put it
in host-only metadata or a separate system row. Do not rewrite the operator
user row.

`[from:]` is only `callerSessionKey` inside `[System] Inform:`.
`SessionsSendInput` has no `from` field. App identity is `context issue`.
`sessions.set-display` is a session label, not a sender.

## CLI

```bash
ravi sessions attach <session> --chat <chat-id> [--reason "..."]
ravi sessions detach <session> --chat <chat-id>
ravi sessions subscriptions <session>
ravi sessions send <session> "<prompt>" -w --json
```

Operator CLI-only `sessions send` (no channel) sends the raw user text.
`[System] Inform:` remains for agent-to-agent / in-context sends. `--raw`
is the escape hatch. Chat-attached `-w` still means delivered.

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
- replay adding the surface instruction only once;
- operator CLI-only and HTTP `sessions.send` persisting raw user text;
- inbound WhatsApp/Slack still receiving the surface instruction.

## Failure Modes

- Mutating `currentSource` when a later message arrives.
- Resolving subscriptions again when a response is emitted.
- Combining messages from different chats before provider delivery.
- Letting a different surface use native steer or host interruption.
- Sending an inbound turn to the default output.
- Implementing the surface instruction in one channel adapter instead of the
  central dispatcher.
