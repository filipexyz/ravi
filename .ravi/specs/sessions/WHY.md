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

## Why Attach Is Separate From Bindings

The original `session_chat_bindings` row records the primary/origin chat.
Multi-input work needs additional wiring, so `session_chat_subscription`
(attach) is a distinct concept. Treating bindings as "the only chat" would block
multi-chat input and cause replies in the wrong chat.

## Why Effective Model Is Resolved, Not Stored

Session JSON reports the effective model through the canonical resolver rather
than persisting a copy. A session `modelOverride` wins over the agent selection
and is reported as `session_override`, shadowing any agent preset — but applying
a preset never mutates session state. See `runtime/model-presets`.
