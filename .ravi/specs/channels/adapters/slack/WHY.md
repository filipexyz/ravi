# Why Slack Needs Its Own Spec

Slack is not "WhatsApp with channels". Slack has workspace identity, channel membership, explicit threads, bot scopes, files, reactions and rendering constraints.

The most important modeling decision is that a Slack channel or DM is a `ChannelChat`, while a Slack thread is a `ChannelThread`. Agent sessions remain separate and may subscribe to either level depending on route policy.

Slack also pushes Ravi to solve generated rendering and streaming fallbacks cleanly because Slack supports richer message formatting but not the same interaction model as WhatsApp.

## Why Thread-First

Slack threads are a strong platform primitive, but they are not Ravi sessions. Treating `thread_ts` as session identity would make routing brittle and would prevent one session from subscribing to multiple Slack contexts.

The safer default is thread-first routing:

- keep threaded conversations in their original thread by default;
- keep `ChannelChat`, `ChannelThread` and `session` separate;
- let route policy decide whether root messages reply in channel root or start a thread;
- preserve Slack semantics without letting Slack own Ravi runtime state.

This keeps the first Slack adapter useful for real work while preserving the Ravi principle that channels transport context and Ravi owns routing/session semantics.

## Why Borrow From Hermes

Hermes' Slack gateway shows the operational details that matter before real workspace usage:

- Socket Mode must have a singleton lock per app/workspace connection.
- Old handlers must be closed before reconnecting to avoid duplicate delivery.
- Slack should be handled as threads, mentions, files and workspace policy, not just plain text.
- Bot filtering needs explicit modes.
- File handling often needs Web API calls with bot-token authenticated downloads.
- Long messages need chunking or post/edit fallback.
- Commands in threads may need text normalization because Slack does not support native slash commands everywhere.

Ravi should borrow these behaviors while keeping the ownership boundary different: Slack adapter delivers channel events; Ravi runtime owns sessions and agents.
