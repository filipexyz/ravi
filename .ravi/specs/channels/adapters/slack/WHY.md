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

## Why Canonicalize Instance Identity

A Slack workspace can be referenced by more than one instance value over its lifetime: the
runtime may address it by a logical account slug, while platform identities for the same
workspace were persisted earlier under the configured legacy instance UUID or an empty
legacy scope. Exact-only identity lookup against whatever value the runtime happens to send
then reports a known actor as unresolved, and authorization correctly grants that
unresolved actor zero capabilities — a false permission denial.

The fix is to make the slug↔UUID relationship explicit and canonical instead of guessing.
Aliases are derived only from configuration for the same instance, so resolution can read
existing rows under either alias (and the exact empty legacy scope) without ever crossing
into another workspace and without treating empty as a wildcard. Canonical writes converge
new rows onto one reference so the ambiguity does not keep growing, while old rows stay
readable and no destructive migration is required.

Ambiguity is treated as a security boundary, not a convenience: if two equivalent aliases
map to different owners, silently picking one could attribute a turn to the wrong principal.
The adapter therefore fails closed with an explicit reason rather than choosing the first
row, keeping unresolved and ambiguous actors at zero capabilities.

The participant cache is only a performance shortcut, so it must not be trusted over that
security boundary. A participant linked during an earlier, non-conflicting turn could
otherwise mask a conflict introduced later, re-attributing turns to a stale owner. Running
the collision check before the cache keeps the fail-closed guarantee true over time. The
same reasoning applies across turn-context rotations: because authority is re-derived from
the resolved actor every turn, a correctly resolved identity must keep its owner and
capabilities stable turn after turn, and an unknown or ambiguous actor must stay at zero —
the regression this fix targets was precisely a known actor flipping to unresolved.

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
