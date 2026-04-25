# Runtime Checks

## Contract

- Every registered built-in provider exposes `id`, `getCapabilities`, and `startSession`.
- Every capability key has explicit tests.
- `prepareSession` output shape is validated.
- Runtime start request fields are provider-agnostic.

## Event Loop

- `text.delta` emits stream chunks without creating assistant messages.
- `assistant.message` emits user-facing response unless silent/interrupted.
- `tool.started` records running state and emits tool start.
- `tool.completed` clears running state and emits tool end.
- `turn.complete` persists provider state, tokens, trace terminal state, and assistant message.
- `turn.interrupted` clears response text and keeps pending prompt queue.
- `turn.failed` emits user-facing error unless suppressed by internal interrupt recovery.

## Queue Semantics

- Messages yielded to a provider turn remain pending until terminal completion.
- Interrupted turns keep pending messages.
- Non-interrupted terminal turns clear yielded pending ids.
- Unsafe tool abort defers until tool completion.
- After-task barriers remain blocked while an active task binding exists.

## Gaps To Close Before Adding Another Provider

- Add a capability for native runtime control operations instead of assuming only one provider supports them.
- Add a capability for dynamic tool calls.
- Add a capability for system prompt mode: append, override, or provider-composed.
- Add a capability for session storage mode: provider id, thread id, file path, or opaque params.
- Add tests for "tool result but no terminal event" recovery.
- Add tests for multiple assistant messages preserving response boundaries.
- Add tests or explicit unsupported status for parallel tool calls.
