---
id: channels/slack/commands
title: Slack Slash Commands
kind: feature
domain: channels
capability: slack
feature: commands
capabilities:
  - slack
  - permissions
tags:
  - slack
  - slash-commands
  - control
  - authority
applies_to:
  - src/channels/slack/slash-commands.ts
  - src/channels/slack/slash-command-handler.ts
  - src/channels/slack/slash-command-render.ts
  - src/channels/slack/thread-controls.ts
  - src/channels/slack/thread-shortcuts.ts
  - src/channels/slack/private-card.ts
  - src/channels/slack/envelope-dedupe.ts
  - src/channels/slack/thread-card.ts
  - src/chat-commands/engine.ts
  - src/chat-commands/parse.ts
  - src/channels/slack/socket-mode.ts
  - src/channels/slack/interactions.ts
  - src/cli/command-access.ts
  - src/permissions/provider-types.ts
  - src/daemon.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Slack Slash Commands

## Intent

A Slack app MUST offer one slash command (`/ravi` by default) that controls Ravi
from the chat where it is typed: who answers there, what is running, which
threads are open, and a way to close threads and stop a turn. The command is
control, not conversation. It MUST NOT open an agent turn, MUST NOT spend model
tokens and MUST NOT be an agent prompt. It acts with the authority of the person
who typed it, never with the authority of an agent.

## Commands

The words are English. Each command is typed after the command name (`/ravi
status`). A word Ravi does not know, an empty text and `help` all show the help.

| Command | What it does | The person needs |
|---|---|---|
| `help` | lists the commands, under the name the command was typed with | nothing |
| `status [thread]` | which agent and session answer in this chat, the model, whether a turn is running and for how long, how many threads are open; with a thread (named as `close` names it), that thread's own state: whether it is closed or working, how long since its last activity, what waits on someone | access to the session |
| `threads` | open threads of the session: name, title, time since the last activity, state (the newest 12, under an exact count) | access to the session |
| `close <thread>` | closes one thread, named as `threads` shows it (also by request id or Slack `thread_ts`) | to modify the session and to hold the capability of `sessions close-thread` |
| `close idle [Nh]` | closes the threads with no activity for more than N hours (default 12, 1 to 720), at most 25 per call | the same as `close` |
| `stop [thread]` | interrupts the turn running in the session of this chat or, with a thread (named as `close` names it), in that thread's own session; the queue goes on | to modify the session and to hold the capability of `sessions runtime interrupt` |

`close idle` MUST consider every open thread of the session, with no page
ceiling, and `status` MUST count them all. It MUST decide idleness from the
runtime's own records, read right before each close and not from a listing read
earlier: the latest of the lifecycle update, the child session's update, its
turn attempts (start, heartbeat, completion) and the health sample MUST be older
than the cutoff, and no turn MUST be running and no prompt queued for it. The
health label is a sample taken every so often, and the lifecycle date does not
move when a parent sends new instructions, so neither alone decides. It MUST
skip a thread with an open question, an undelivered answer or a return still
pending to the channel session, MUST say how many it skipped for recent activity
or work in progress, and MUST tell how many remain when it stopped at the
limit. `close` MUST show why a
thread did not close: the active triggers that hold it (`THREAD_TRIGGERS_PENDING`,
with their ids and the `ravi triggers set <id> replySession <channel-session>`
way out), an open question (`THREAD_DECISIONS_PENDING`), a pending return
(`THREAD_PARENT_RETURN_PENDING`), or the code of any other refusal.

Slack does not let an app's slash command run inside a thread. The commands act
on the session of the DM or channel they are typed in, and name a thread by
argument (`close <thread>`, `stop <thread>`). The control of one thread, where
it is, is on its card: the root card of a thread Ravi opened carries **Fechar**
and **Parar** (not once the thread is closed). Each asks Slack's own
confirmation first and then runs the same command as `close <thread>` or `stop
<thread>`, with the same authority, for the thread whose card was clicked.

The "..." menu of any message in a thread carries three **message shortcuts**,
when the operator creates them in the app (`ravi_status_thread`,
`ravi_close_thread`, `ravi_stop_thread`): status of the thread, close it, stop its
turn. Status answers at once. Close and stop ask first, on a private card with
Confirm and Cancel, and run only when Confirm is pressed.

## Invariants

### Runner (Socket Mode)

- A `slash_commands` envelope MUST be acked first, inside Slack's 3 seconds.
  Help, usage and an unknown word are static: the ack MUST carry their ephemeral
  message when Slack accepts a payload in the ack (`accepts_response_payload`),
  and every other command MUST get an empty ack.
- The envelope MUST NOT enter the durable Slack inbox, MUST NOT reach routing and
  MUST NOT publish a session prompt. A restart MUST NOT replay a command.
- A repeated `envelope_id` MUST NOT be published twice.
- Socket Mode has no request signature: the event arrives on a WebSocket
  authenticated by the app token. The runner MUST instead verify, after the ack,
  that the command's `team_id` is the workspace of this instance's own bot
  (`auth.test`), failing closed when that cannot be read; that its `api_app_id`
  is the app this connection first named; and it MUST take the instance from the
  runner, never from the payload. A command that fails is dropped with a log
  line and nothing is published.
- Only the fields in `SlackCommandPayload` are read. `token`, `user_name`,
  `team_domain` and the rest MUST NOT be read, published or logged.
- The `response_url` MUST be stored behind an id and only that id published. A
  command with no usable `response_url` and no static answer MUST NOT run:
  nobody could be told what happened.
- A shortcut (`message_action`, `shortcut`) whose response handle is of a shape
  Ravi does not trust MUST be published without the handle, with a log line naming
  only the host and the first path segment, and saying whether the shape is one
  Slack does not issue or the handle could not be stored: a shortcut answers with a private
  card and does not need it. Any other interaction whose handle is not trusted MUST
  still be refused.
- The event is `ravi.inbound.command` with `provider`, `source`, `accountId`,
  `routeAccountId`, `instanceId`, `envelopeId`, `apiAppId`, `teamId`,
  `enterpriseId`, `channelId`, `userId`, `command`, `text`, `triggerId`,
  `responseUrlId`, `ackedWithHelp` and `receivedAt`. It MUST NOT carry the token
  or the `response_url`.

### Daemon: the engine and this adapter

The commands are the channel-free engine's (spec `permissions/chat-commands`,
`src/chat-commands/`): the grammar, the freshness window, the authority, the
operations and the audit are the same for every channel and MUST NOT be written
again here. This adapter (`slash-command-handler.ts`) provides only what is
Slack's: it reads the `ravi.inbound.command` event, says which contact the Slack
user is, resolves the chat to a session, owns the Slack threads (lifecycle
store, closing), and says each result in Slack's words and mrkdwn
(`slash-command-render.ts`) through the stored `response_url`. The engine hands
it facts (`ChatCommandResult`), never Slack text; the adapter hands the engine
values, never code.

- One consumer per daemon MUST read `ravi.inbound.command` in its own queue group
  (`ravi-slack-commands`), so one daemon answers each command.
- A command MUST run only while fresh: older than 60 seconds, or stamped more
  than 60 seconds in the future, it MUST NOT run, and the person MUST be told it
  was not run.
- The Slack user MUST resolve to a contact exactly as an approval click does
  (the instance's aliases, then the empty legacy scope). A user with no contact
  MUST get a private refusal and MUST NOT run anything. Static answers
  (`help`, usage) need no contact.
- The chat MUST resolve to the session an agent answers in the way an inbound
  message there would, without creating anything: the route for the chat (a DM
  by the user's id, a channel by `group:<id>`), then a subscription that
  attaches the chat to another session unless the route forces its own. No route
  MUST say "No agent answers in this chat"; a route whose session does not exist
  yet MUST say which agent would answer and that nobody has spoken there.
- Authority MUST be the contact's own and MUST come from the same permission
  providers the CLI uses: the capabilities the contact's tags and grants
  materialize to. Every check MUST name the contact as subject as well as carry
  its capabilities, so a configured external authority is consulted and can
  refuse what the local grants would allow. Reading (`status`, `threads`) MUST
  require `access` on the session. Changing (`close`, `close idle`, `stop`) MUST require `modify` on the
  session AND the capability the CLI asks for the operation it calls
  (`sessions close-thread`, `sessions runtime interrupt`), read from the access
  metadata the CLI declares for that operation so it cannot drift. When that
  metadata cannot be read the command MUST be refused.
- The command-level check MUST run as `source: "channel-command"` with the contact
  as subject: no ambient runtime context, no agent ceiling and no local
  operator authority may stand in for it. Without a contact it MUST be denied.
  The source names no channel: the command authority and the permission provider
  contract (`command-access.ts`, `provider-types.ts`) MUST NOT mention any
  channel, and a Slack-specific rule lives in this adapter, never in the core.
- `stop` MUST ask the runtime on `ravi.session.runtime.control` with
  `turn.interrupt`, the request `ravi sessions runtime interrupt` makes. It MUST
  say "nothing running" when there is no active turn, and MUST NOT claim a stop
  it could not confirm (a timeout or an unreachable runtime is said as such).

### Answers

- Every answer MUST be ephemeral, posted through the stored `response_url`.
  A `response_url` handle MUST be posted to at most five times (Slack's limit),
  the sixth refused before any request. The use MUST be taken in one statement
  that also checks the limit, before the request, so two callers cannot take the
  last one. It MUST be given back when Slack answers and refuses, and MUST stay
  spent when the request fails without an answer. A handle MUST be accepted only
  over https with no port and no credentials, and only in these two shapes:
  `hooks.slack.com` under `/actions/`, `/app-actions/` (a message shortcut's, the
  shape Slack's shortcut payload reference shows) or `/commands/`, or one
  `<workspace>.slack.com` label under `/commands/` alone. Slack's Socket Mode
  example for a slash command shows `https://<workspace>.slack.com/commands/...`
  and its HTTP example `https://hooks.slack.com/commands/...`; nothing shows an
  interaction handle on the workspace host, so it MUST NOT be accepted there. A
  post MUST have a deadline.
- An unexpected failure MUST be answered with a retry message and MUST NOT
  expose the error text.

### Thread card buttons

- The buttons MUST be on the root card of a thread Ravi opened (`ravi sessions
  create-thread`, and every re-render of that card) and nowhere else: the card
  builder takes `controls` as an opt-in, so a card of another kind (a cloud run's)
  MUST NOT get them. A closed thread MUST NOT show them. Each button MUST ask
  Slack's own confirmation before the click is sent, and MUST carry no thread id.
- A click is a `block_actions` interaction with action id `ravi_thread_close` or
  `ravi_thread_stop`, published by the runner on `ravi.inbound.interaction` with
  `routeAccountId` (the scope routes are matched in, as for a slash command). A
  consumer in its own queue group (`ravi-slack-thread-controls`) MUST turn it
  into the engine command `close <ts>` or `stop <ts>`; no other interaction MUST
  be touched, and an interaction with no arrival time or a `ts` that is not a
  Slack timestamp MUST NOT run.
- The person MUST be the Slack user id of the interaction payload, resolved to a
  contact like a typed command's. The thread MUST be the clicked card's own
  message, looked up among the threads of the session the clicked chat resolves
  to and opened in the clicked chat (a Slack `ts` is only unique within a channel,
  so another channel's thread of the same session with the same root MUST NOT
  answer): a card MUST NOT name a thread of another chat's session.
- The same engine decides, so the freshness window, the authority (`modify` on the
  session and the CLI's capability) and the audit are a typed command's; the
  audit row MUST record `surface: "button"`. The answer MUST be ephemeral,
  through the click's `response_url`, and MUST say `replace_original: false`: on a
  button's `response_url` Slack replaces the message the button is on when the
  field is missing, and a close has already refreshed the card to "closed", so an
  answer that does not say it overwrites the card with one line. Only the
  confirmation card of a message shortcut (its own ephemeral message) is answered
  with `replace_original: true`. A click Slack delivers twice (same envelope
  id) MUST be answered once.

### Message shortcuts

- A shortcut is a `message_action` interaction the runner publishes on
  `ravi.inbound.interaction`, carrying the `callback_id` the app declares for it
  (`callbackId`) and nothing of the message's own text. A consumer in its own
  queue group (`ravi-slack-thread-shortcuts`) MUST read only the three callback
  ids above and the buttons of its own confirmation card (`ravi_confirm_close_thread`,
  `ravi_confirm_stop_thread`, `ravi_cancel_thread_action`); no other interaction
  MUST be touched. A tap with no arrival time, or whose thread is not a Slack
  timestamp, MUST NOT run.
- The thread MUST be the root of the thread the message is in (`thread_ts`, or
  the message's own `ts` when it starts one), looked up among the threads of the
  session the chat resolves to and opened in the chat it was used in: a shortcut
  MUST NOT name a thread of another chat's session, nor another channel's thread
  of the same session with the same root `ts`. The person MUST be the Slack user id of the payload, resolved
  to a contact; nothing typed or written in the message is read.
- `status` MUST run the engine command `status <ts>`. `close` and `stop` MUST NOT
  change anything when picked: they MUST send a private card with Confirm and
  Cancel, and the engine command (`close <ts>`, `stop <ts>`) MUST run only when
  Confirm is pressed. Authority MUST be read when it runs, by the same engine as a
  typed command: `modify` on the session and the CLI's capability. A shortcut that
  arrived more than 60 seconds after it was picked MUST NOT ask.
- A confirmation click MUST be read only from the chat of its card or from a DM
  with the app (a `D` conversation, where Slack puts the card when it will not
  show it in the chat); a click from any other conversation MUST NOT run.
- The confirmation card MUST carry only the thread and the time it was asked (in
  the button value, a hint the click checks and never an authority), and MUST NOT
  name a person. A confirmation asked more than ten minutes ago, or stamped more
  than a minute in the future, MUST NOT run: the card says it expired.
- Every answer MUST be private to the person and in the thread: an ephemeral
  card where they are (`ravi.outbound.deliver` with `privateTo` and `threadId`,
  the path approval cards use), or their DM with the app when Slack refuses that.
  A shortcut's own `response_url` posts at channel level, where a person looking
  at a thread does not see it, so it MUST be used only when the card could not be
  sent, and for the confirmation card's own click (replacing the card with the
  answer).
- The audit row MUST record `surface: "shortcut"`. A tap Slack delivers twice
  (same envelope id) MUST be answered once.

### Audit

- Every command that reaches the daemon, including the refused and the static,
  MUST publish `ravi.audit.chat_command` (the engine's, one topic for every
  channel) with `channel: "slack"`, the contact, the Slack user as `actorId`, the
  chat as `chatId`, the envelope id as `requestId`, `surface` (`command`,
  `button` or `shortcut`), the session, the subcommand,
  the decision (`allowed`, `denied`, `info`, `error`) and a result code. It MUST
  NOT carry the text typed, a thread name, the `response_url` or any token. A
  failed audit publish MUST NOT fail the command. What the runner refuses
  before it publishes (another workspace, an unverified origin, an unreadable
  payload, no response URL with no static answer) is visible only in the runner's
  log.

## Known limits

Recorded limits, the first ones security debt that is not a defect of this
feature alone, with no change planned here:

- The daemon takes `ravi.inbound.command` as published by the runner. The local
  NATS bus has no authentication, so a process on the machine that can publish
  could forge a command with another person's Slack user id. The same limit holds
  for `ravi.inbound.interaction`. It belongs to the bus authentication debt, not
  to this feature.
- The app is pinned by the first command a connection sees (`api_app_id`, trust
  on first use). A Socket Mode connection only receives its own app's envelopes,
  so this is an extra consistency check and `team_id` is the check that counts.
  Comparing with the app id `auth.test` returns, when it does, would close it.
- A click or tap is deduplicated by its envelope id in the memory of the daemon
  process (`envelope-dedupe.ts`, 1000 per consumer). A restart empties it, so a
  tap Slack redelivers across a restart is answered again. What a tap does absorbs
  that (`close` on a closed thread says it was already closed, `stop` with nothing
  running says so), and the freshness window refuses a tap that is too old to run.
- Slack shows an ephemeral message in a thread only when the thread already has
  replies (`chat.postEphemeral` with `thread_ts`). A shortcut picked on the first
  message of a thread nobody has answered yet may get no visible card; the
  `/ravi` command, or the buttons on the thread's card, work there.
- A shortcut's confirmation is a private card and not a modal. A modal has to be
  opened within three seconds of the tap, by whoever holds a Slack Web client with
  the right to open views: today only the runner does, and the daemon, where the
  engine runs, reaches Slack through the credential broker for message sends only.
  Moving to a modal means changing that authority, and is a decision of its own.
- The confirmation card does not name the thread (the daemon looks the thread up
  only when it runs). It sits in the thread it is about; in the DM fallback, where
  Slack refused to show it in the chat, it is only as clear as that DM.
- `/ravi status <word>` used to ignore the word. It now names a thread.
- A typed command names a thread by any of its names (name, request id, root
  `ts`) among every thread of the session of the chat, so a root `ts` copied from
  another channel of the same session names that channel's thread. Shortcuts and
  buttons are tighter: they name the thread by the chat they were used in.
- The chat scope that shortcuts and buttons use (a thread by the channel it was used in
  and its root `ts`) only fits a root-`ts` ref. `close idle` closes by request id, which that
  scope would not find, so it stays unscoped. Today no button or shortcut runs it (they build
  `close <ts>` and `stop <ts>`), but the rule that the scope comes from the surface would
  break silently if one ever did.

## Out of scope for this feature

A confirmation modal for the shortcuts, shortcuts that are not on a message of a
thread (global shortcuts), the move to `agent_view`, a read-only mode for guests,
per-person rate limits, and commands that change routes, agents, permissions,
secrets, the daemon or the release.
