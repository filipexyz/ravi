# Claude Code Provider Checks

## Required Tests

- Stream delta maps to `text.delta`.
- Assistant text maps to `assistant.message`.
- Assistant tool-use maps to `tool.started`.
- User tool-result maps to `tool.completed`.
- Success result maps to `turn.complete` with session state and usage.
- Non-success result maps to recoverable `turn.failed`.
- Query exception maps to recoverable `turn.failed`.
- `setModel` updates active query when possible and always affects next query.
- A live provider session snapshots the current Ravi env for every query: a
  rotated `RAVI_CONTEXT_KEY` appears on the next turn, removed managed values do
  not survive, and the Claude session id is still resumed.
- Resume session id is read from `RuntimeSessionState.params`.
- Fork is passed only when requested by session continuity.
- A real POSIX shell preserves a single auth token and multiple forwarded auth,
  context and gateway values, including shell metacharacters and newlines.
- A loopback SSH agent receives the enabled daemon HTTP gateway URL; an
  unrelated remote host does not receive an inferred loopback URL.
- An explicit gateway URL takes precedence, invalid HTTP ports do not create a
  URL, and unrelated secrets never enter the forwarded environment.
- Gateway derivation follows the listener's configuration precedence: an
  explicitly empty HTTP port disables fallback to the webhook port, and HTTP
  and webhook host values are trimmed before selecting the IPv6 loopback URL.

## Regression Cases

- Native interruption throws an abort-like error after Ravi requested interrupt.
- Provider emits partial text but no assistant message.
- Provider emits assistant message before a tool result.
- Provider emits result with missing usage.
- Hooks are missing for an agent that requires restricted tool access.
- Plugin attachment exists but provider capabilities are false.
- Spec server attachment exists for non-spec agents.
