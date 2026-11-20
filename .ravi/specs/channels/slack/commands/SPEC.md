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
| `status` | which agent and session answer in this chat, the model, whether a turn is running and for how long, how many threads are open | access to the session |
| `threads` | open threads of the session: name, title, age, state (newest first, at most 12) | access to the session |
| `close <thread>` | closes one thread, named as `threads` shows it (also by request id or Slack `thread_ts`) | to modify the session and to hold the capability of `sessions close-thread` |
| `close idle [Nh]` | closes the threads with no activity for more than N hours (default 12, 1 to 720), at most 25 per call | the same as `close` |
| `stop` | interrupts the turn running in the session of this chat; the queue goes on | to modify the session and to hold the capability of `sessions runtime interrupt` |

`close idle` MUST skip a thread that has a turn running, an open question, an
undelivered answer or a return still pending to the channel session, and MUST
tell how many remain when it stopped at the limit. `close` MUST show why a
thread did not close: the active triggers that hold it (`THREAD_TRIGGERS_PENDING`,
with their ids and the `ravi triggers set <id> replySession <channel-session>`
way out), an open question (`THREAD_DECISIONS_PENDING`), a pending return
(`THREAD_PARENT_RETURN_PENDING`), or the code of any other refusal.

Slack does not let an app's slash command run inside a thread. The commands act
on the session of the DM or channel they are typed in, never on a thread.

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
- The event is `ravi.inbound.command` with `provider`, `source`, `accountId`,
  `routeAccountId`, `instanceId`, `envelopeId`, `apiAppId`, `teamId`,
  `enterpriseId`, `channelId`, `userId`, `command`, `text`, `triggerId`,
  `responseUrlId`, `ackedWithHelp` and `receivedAt`. It MUST NOT carry the token
  or the `response_url`.

### Daemon

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
  materialize to. Reading (`status`, `threads`) MUST require `access` on the
  session. Changing (`close`, `close idle`, `stop`) MUST require `modify` on the
  session AND the capability the CLI asks for the operation it calls
  (`sessions close-thread`, `sessions runtime interrupt`), read from the access
  metadata the CLI declares for that operation so it cannot drift. When that
  metadata cannot be read the command MUST be refused.
- The command-level check MUST run as `source: "slack-command"` with the contact
  as subject: no ambient runtime context, no agent ceiling and no local
  operator authority may stand in for it. Without a contact it MUST be denied.
- `stop` MUST ask the runtime on `ravi.session.runtime.control` with
  `turn.interrupt`, the request `ravi sessions runtime interrupt` makes. It MUST
  say "nothing running" when there is no active turn, and MUST NOT claim a stop
  it could not confirm (a timeout or an unreachable runtime is said as such).

### Answers

- Every answer MUST be ephemeral, posted through the stored `response_url`.
  A `response_url` handle MUST be posted to at most five times (Slack's limit),
  the sixth refused before any request, MUST be accepted only on
  `https://hooks.slack.com/actions/` or `https://hooks.slack.com/commands/`, and
  a post MUST have a deadline.
- An unexpected failure MUST be answered with a retry message and MUST NOT
  expose the error text.

### Audit

- Every command, including the refused and the static, MUST publish
  `ravi.audit.slack_command` with the contact, the Slack user, the chat, the
  session, the subcommand, the decision (`allowed`, `denied`, `info`, `error`)
  and a result code. It MUST NOT carry the text typed, a thread name, the
  `response_url` or any token. A failed audit publish MUST NOT fail the command.

## Out of scope for this feature

Message shortcuts and thread buttons, modals, the move to `agent_view`, a
read-only mode for guests, per-person rate limits, and commands that change
routes, agents, permissions, secrets, the daemon or the release.
