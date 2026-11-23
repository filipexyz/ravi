---
id: permissions/chat-commands
title: Chat Commands
kind: capability
domain: permissions
capability: chat-commands
capabilities:
  - engine
  - authority
  - audit
tags:
  - chat-commands
  - control
  - authority
  - channel-free
applies_to:
  - src/chat-commands/engine.ts
  - src/chat-commands/parse.ts
  - src/cli/command-access.ts
  - src/permissions/provider-types.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Chat Commands

## Intent

A person MUST be able to control Ravi from a chat, in whichever channel that
chat is: who answers there, what is running, which threads are open, and a way
to close threads and stop a turn. The command is control, not conversation: it
MUST NOT open an agent turn, MUST NOT spend model tokens and MUST NOT be an
agent prompt. It acts with the authority of the person who typed it.

This feature is core. It MUST NOT know any channel: Slack, WhatsApp and the rest
reach it only as adapters, the same rule the grant requests follow. Today the
only adapter is Slack (spec `channels/slack/commands`).

## The grammar

`help | status | threads | close <thread> | close idle [Nh] | stop`, parsed by
`parseChatCommandText` (`src/chat-commands/parse.ts`), a pure function. Words are
matched without accents or case; a thread ref keeps its case. Idle hours are 1 to
720, default 12. `help`, an empty text, an unknown word and a malformed `close`
are static: they need no contact, no session and no authority.

## The engine

`runChatCommand(channel, deps)` (`src/chat-commands/engine.ts`) runs one command,
start to answer. In this order:

1. A command MUST run only while fresh: older than 60 seconds, or stamped more
   than 60 seconds in the future, it MUST NOT run and the result is `stale`. The
   window MUST be checked again right before anything changes, because loading
   the access metadata can take a while.
2. Static commands answer `static` and stop, with no identity lookup: a lookup
   that fails MUST NOT take help away.
3. The adapter's `contactId()` MUST say who the person is. Without a contact
   nothing runs (`unknown_actor`).
4. The adapter's `resolveSession` MUST give the session an agent answers in for
   the chat (`session`), or say why not (`no_route`, `route_conflict`,
   `session_missing`). A session of another agent than the route's MUST NOT run.
5. Authority, below.
6. The operation runs and returns facts.
7. The adapter's `reply` says the result; the audit row is published.

A failure anywhere in the flow MUST be answered (`failed`) and audited, not left
to the caller.

## Authority

- The authority MUST be the contact's own and MUST come from the same permission
  providers the CLI uses: the capabilities the contact's tags and grants
  materialize to. Every check MUST name the contact as subject as well as carry
  its capabilities, so a configured external authority can refuse what the local
  grants would allow.
- Reading (`status`, `threads`) MUST require `access` on the session. Changing
  (`close`, `close idle`, `stop`) MUST require `modify` on the session AND the
  capability the CLI asks for the operation it calls (`sessions close-thread`,
  `sessions runtime interrupt`), read from the access metadata the CLI declares
  so it cannot drift. The metadata for the command that closes a channel's
  threads comes from the channel (`closeAccess`), because that command is the
  channel's own (for Slack it imports Slack's thread code): the engine reads only
  the runtime control class, the same for every channel. When that metadata
  cannot be read the command MUST be refused, and so MUST a command that changes
  state (`close`, `close idle`, `stop`) whose declared access is not a mutating
  one: a channel that declared a read command for it would let a reader through. The map is `CHAT_COMMAND_SESSION_RIGHT` and a refusal MUST come before
  any operation.
- The command-level check MUST run as `source: "channel-command"` with the
  contact as subject. No ambient runtime context, no agent ceiling, no local
  operator and no Console invocation the daemon happens to run inside may stand
  in for it. The source names no channel; `src/cli/command-access.ts` and
  `src/permissions/provider-types.ts` MUST NOT mention any channel.
- The identity of the person MUST come from the channel's verified sender,
  resolved by the adapter, never from the text typed.

## Operations

- `status`: the agent and session, the model, whether a turn is running and for
  how long, and how many threads are open when the channel has threads.
- `threads`: the newest 12 open threads as facts (name, title, time since the
  last activity, busy, health, open questions, return pending, session gone)
  under an exact total, with no silent ceiling.
- `close <thread>`: closes one thread through the adapter; says closed, already
  closed, not found, or refused with the code and message.
- `close idle [Nh]`: closes the threads idle for more than N hours, at most 25
  per call and at most 100 tries per call, so refusals cannot hide the threads
  behind them. It MUST decide idleness from the runtime's own records, read right
  before each close: the latest of the lifecycle update, the child session's
  update, its turn attempts and the health sample MUST be older than the cutoff,
  and no turn running and no prompt queued. It MUST skip a thread with an open
  question, an undelivered answer or a pending return, and MUST count only the
  closes it made.
- `stop [thread]`: asks the runtime on `ravi.session.runtime.control` with
  `turn.interrupt`, the request `ravi sessions runtime interrupt` makes, for the
  session of the chat or, given a thread, for that thread's own session (found by
  the channel's `findThread`, in the threads of the chat's session). The rights
  asked are the same either way and come before the thread is looked up. It MUST
  say nothing is running when no turn is, MUST say a thread that is not found or
  has no session left, and MUST NOT claim a stop it could not confirm (a timeout
  and an unreachable runtime are said as such).
- A channel with no threads MUST say so (`threads_unsupported`) for `threads`,
  `close` and `close idle`, not pretend there are none.

## Results and the adapter

The engine MUST answer with `ChatCommandResult`, facts and never text for a
channel. The adapter MUST word and format them for its platform, including
escaping. The adapter provides the event, the contact lookup, the session of the
chat, the threads (index, closing) and the delivery of the answer; the engine
provides everything else.

## Audit

Every command, the refused and the static included, MUST publish
`ravi.audit.chat_command` with `channel` (a value the adapter supplies), the
account, the instance, the chat, the person as the platform knows them
(`actorId`), the contact, the session, the subcommand, the decision (`allowed`,
`denied`, `info`, `error`), a result code, the platform's request id when it
has one, and how the person reached the command (`surface`, a value the adapter
supplies: a typed command, a button) when it says. It MUST NOT carry the text
typed, a thread name, a URL or any token. A failed audit publish MUST NOT fail
the command, and a delivery failure of the answer MUST NOT stop the audit.

## Architecture

`src/chat-commands/` MUST NOT name any channel and MUST NOT import channel code;
a test reads its files and fails on a channel name or a `channels/` import, and
on the import of the CLI command class that closes a channel's threads.

## Known limits

Recorded, with no change planned here:

- The test above reads only the direct imports of `engine.ts` and `parse.ts`.
  The core already reaches Slack code by transitive paths that this feature did
  not add: `router/router-db.ts` imports `channels/slack/automatic-terminal-manifest.ts`,
  `router/sessions.ts` imports `channels/context.ts`, and
  `runtime/session-chat-identity.ts` imports `channels/capabilities.ts`. The
  engine's own files are clean; the router naming a channel is a debt of the core.

## Out of scope

Message shortcuts and modals, `status <thread>`, a second channel's adapter,
per-person rate limits, and commands that change routes, agents, permissions,
secrets, the daemon or the release.
