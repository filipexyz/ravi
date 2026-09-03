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
  - src/runtime/runtime-request-builder.ts
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

Operator / HTTP / app `sessions.send` with the same shape (session-relay,
no `--channel`/`--to`, no real inbound chat) is a **session destination
for emit too**. Leftover `lastChannel` / `lastTo` MUST NOT be copied into
`prompt.source` / `currentSource`. The default output attachment MUST NOT
be the emit target. Chat emit MUST fail closed (`Response target
unresolved — dropping emit`). Do not invent a chat `.response` sink.
Persist stays independent: `saveMessage` on `turn.complete` plus
`sessions.read` / `getRecentHistory` by `session_id`.

The default output is only a fallback for proactive and other source-less
turns (cron, heartbeat, follow-up). It never overrides an inbound source
and MUST NOT claim a session-relay operator send.

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

Every new logical turn has two payloads:

- **runtime prompt** — what the provider/model sees
- **persisted user row** — what `sessions read`, chat display, and transcript
  show

The dispatcher adds exactly one short English instruction to the
**runtime** prompt:

```text
[session surface] This turn came from a Slack chat. A normal reply returns there.
```

For a thread, it says `Slack thread`. For a CLI-only operator turn, it says
that a normal reply returns to the waiting CLI. For HTTP / app session-relay
send with no inbound chat, it says that a normal reply stays on this
session. For other source-less turns (cron, heartbeat, follow-up), it says
that the session default will be used when one is available.

The instruction MUST NOT include session names, chat ids, subscription lists,
roles, database fields, or routing commands. It is added centrally so every
channel uses the same contract, and it MUST remain idempotent across durable
replay.

Inbound WhatsApp/Slack may keep the instruction on the persisted user prompt
when the channel already shows the original message separately.

Operator CLI-only and HTTP/user `sessions.send` MUST persist the raw user
text. Honor `--raw`. Do not glue `[session surface]`, `waiting CLI`, or
`no inbound chat` into that `user.text`. Put the header on launch-prompt
metadata (`_sessionSurfaceHintText` / `_runtimePrompt`) and inject it into
the model prompt. Leftover `lastChannel` on a session-relay send is not an
inbound chat turn.

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
- `--json` attach/detach MUST report the final state: session identity/name,
  requested chat id, whether that chat is attached, whether it is the default
  output, remaining active subscriptions (chat id, role, default output,
  detached flag), and explicit `legacy.status` of `none` for
  `session_chat_bindings`. Human output MUST summarize the same state.

There is no speech mode. `mute`, `unmute`, and `focus` are not part of this
capability.

`@@SILENT@@` suppresses only the current response. It does not modify session
wiring.

## Persistence

- `session_chat_subscriptions` is the sole source of truth for attach, detach,
  inbound chat participation, and default output.
- One chat belongs to at most one active session. One session MAY have many
  active chats. At most one active output exists per session.
- `detach` removes the active association and clears default output for that
  chat. It MUST NOT delete the session or its history. Repeated detach is
  idempotent.
- Resetting provider continuity MUST preserve chat subscriptions.
- Deleting a session MUST cascade to its subscriptions.
- Existing databases may retain obsolete speech columns; runtime and CLI code
  MUST ignore them. New schemas do not create them.
- Legacy `session_chat_bindings` MUST NOT be created, read, or written at
  runtime. Compatibility migration converts leftover useful rows into
  subscriptions once, then drops the table. Migration MUST be idempotent and
  MUST NOT resurrect an intentionally detached pair or insert a second active
  output for a session.

## Validation

```bash
bun test src/router/session-attach.test.ts src/runtime/session-output-target.test.ts
bun test src/runtime/delivery-queue.test.ts src/runtime/session-dispatcher.test.ts
bun test src/runtime/session-surface-hint.test.ts src/omni/consumer-context.test.ts
bun test src/cli/commands/sessions.test.ts
bun test src/channels/slack/socket-mode.test.ts src/channels/slack/thread-lifecycle.test.ts
```

Regression coverage MUST include:

- detach with another output selected in the same session;
- detach with no competing output, with no resurrection after repeated DB
  initialization;
- repeated detach remaining idempotent;
- one-time binding migration being idempotent and never violating the unique
  output index;
- preservation of unrelated chats and session history;
- inbound consumer creating/using subscriptions only, never legacy bindings;
- CLI attach/detach JSON and human output exposing final attached/default
  state and reporting no legacy binding;
- Slack active, WhatsApp queued, then one reply to each source in order;
- two Slack threads remaining separate;
- source-less output using the default attachment;
- session-relay / HTTP operator send not emitting to leftover lastChannel
  or the default output, while persist/read still has the assistant row;
- inbound WhatsApp/Slack still emitting to the source chat;
- an unattached inbound source failing closed;
- replay adding the surface instruction only once;
- operator CLI-only and HTTP `sessions.send` persisting raw user text
  while the runtime prompt still carries the surface header;
- inbound WhatsApp/Slack still receiving the surface instruction.

## Failure Modes

- Mutating `currentSource` when a later message arrives.
- Resolving subscriptions again when a response is emitted.
- Combining messages from different chats before provider delivery.
- Letting a different surface use native steer or host interruption.
- Sending an inbound turn to the default output.
- Implementing the surface instruction in one channel adapter instead of the
  central dispatcher.
- Gluing the surface header into an operator `user.text` row, or omitting
  it from the model-facing runtime prompt.
