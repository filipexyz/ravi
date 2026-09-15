# Sessions Rationale

## Why Sessions Own Identity, Not Transport

A session is the runtime container for one agent working on a stream of inputs.
Transport surfaces (channels, chats), provider continuity, and thread context
all *reference* a session but must not redefine it. Centralizing session
identity (`session_key`, `session_name`, `agent_id`, `cwd`) keeps routing stable
when display names change and prevents each transport from inventing its own
notion of a session.

## Why session_key Is Stable

`session_key` is a durable composite identifier. Renaming the human-facing
`session_name` must never rewrite `session_key`, otherwise routing and provider
continuity break for an already-running session.

## Why Session-Relay Send Is Not Chat Emit

Operator / HTTP / app `sessions.send` injects a prompt into a session. It is
not inbound WhatsApp/Slack. Copying leftover `lastChannel`/`lastTo` into
`prompt.source` made emit treat that send as a chat reply — including onto
`main` when the leftover chat was attached. The default output attachment
has the same leak once the leftover source is stripped. Persist already
stores the assistant row; emit must fail closed instead of inventing a
chat sink.

## Why Attach Uses Subscriptions Only

`session_chat_subscriptions` records every participating chat and the one
default output. The retired `session_chat_bindings` 1:1 row was a second
ledger: detach cleared the subscription but left the binding, and startup
backfill could recreate the attachment or fail the unique output index.
Migration converts leftover useful rows once and drops the table.

## Why Effective Model Is Resolved, Not Stored

Session JSON reports the effective model through the canonical resolver rather
than persisting a copy. A session `modelOverride` wins over the agent selection
and is reported as `session_override`, shadowing any agent preset — but applying
a preset never mutates session state. See `runtime/model-presets`.
