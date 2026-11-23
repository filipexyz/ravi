# Why

## Why a core engine, not the Slack handler

`/ravi` shipped as a Slack handler that held the grammar, the rights map, the
operations and the audit. Only the authority (`channel-command`) was core. The
independent review of that PR said it plainly: a second channel would have to copy
the handler (N4). The rule of 23/11 says a core feature is never tied to one
channel; Slack and the rest are adapters of delivery and input. So the part that
is the same for every channel moved to `src/chat-commands/`, and the Slack file
kept only what is Slack's.

## Why facts, not text

The engine answers with `ChatCommandResult`. Wording and markup are channel
matters: Slack needs mrkdwn escaping, another channel needs its own. If the core
wrote the text it would carry one channel's format. Facts also make the tests of
the authority and the operations independent of any wording.

## Why the audit topic is neutral

The audit row is the engine's, so its topic is `ravi.audit.chat_command` and the
channel is a value (`channel: "slack"`), not a different topic per channel. The
first topic, `ravi.audit.slack_command`, existed for hours and was never in a
release, so no consumer is renamed under a contract.

## Why `close idle` is tested at the right level

Review found that a mutant letting `close idle` ask only for `access` survived the
whole suite. The right of each subcommand is now asserted in the engine with a
reader, before anything runs, so the rights map and its use cannot drift apart.

## Why a channel may have no threads

Threads are a Slack idea today. A channel without them gets an explicit
`threads_unsupported` instead of a count of zero, which would be a lie.
