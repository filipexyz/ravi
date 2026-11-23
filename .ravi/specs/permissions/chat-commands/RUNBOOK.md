# Runbook

## See what was run

Every chat command, refused ones included, is published on
`ravi.audit.chat_command` with the channel as a value:

```bash
ravi events replay --subject ravi.audit.chat_command --since 1h
```

Each row has the channel, the account and instance, the chat, the person as the
platform knows them (`actorId`), the contact, the session, the subcommand, the
decision (`allowed`, `denied`, `info`, `error`) and a result code. The text typed
and the thread named are not in it.

Result codes worth knowing: `unknown_user` (nobody linked that person to a
contact), `not_authorized_access` and `not_authorized_modify` (the contact lacks
the right on the session), `not_authorized_command` (it lacks the CLI's own
capability), `route_conflict` (the route forces a session of another agent),
`stale` (the command arrived more than a minute late), `failed` (an unexpected
error; the engine answered a retry message).

## Why a command was refused

1. Is the person a contact? `ravi contacts` and the channel's identity link.
2. Which session answers in that chat? Ask the adapter's channel docs; for Slack
   `ravi routes explain <instance> group:<channel-id>`.
3. What does the contact hold? `ravi permissions` for the contact; reads need
   `access` on the session, changes need `modify` and the CLI's capability.

## Add a channel

1. Write an adapter that builds a `ChatCommandChannel` from its own event: the
   `origin` (channel name as a value, account, instance, chat, actor, request
   id), the text after its command word, `receivedAt`, `contactId()` from its own
   identity lookup, `resolveSession` (the session an agent answers in, resolved
   the way an inbound message there would be), the thread index and `closeThread`
   if the platform has threads, and `reply`.
2. Word and format each `ChatCommandResult` for the platform, escaping included.
   `reply` must not throw.
3. Call `runChatCommand(channel)`.
4. Keep every channel name and rule out of `src/chat-commands/` and out of
   `src/cli/command-access.ts`: a test fails on a channel name.

## Validation commands

```bash
bun test src/chat-commands/ src/cli/command-access.test.ts
bun test src/channels/slack/slash-command-handler.test.ts
bun run typecheck
```
