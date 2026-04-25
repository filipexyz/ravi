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
- Resume session id is read from `RuntimeSessionState.params`.
- Fork is passed only when requested by session continuity.

## Regression Cases

- Native interruption throws an abort-like error after Ravi requested interrupt.
- Provider emits partial text but no assistant message.
- Provider emits assistant message before a tool result.
- Provider emits result with missing usage.
- Hooks are missing for an agent that requires restricted tool access.
- Plugin attachment exists but provider capabilities are false.
- Spec server attachment exists for non-spec agents.
