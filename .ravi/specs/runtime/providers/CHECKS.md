# Runtime Providers Checks

## Contract Tests

- Provider exposes stable id.
- Capability matrix includes every required capability key.
- `prepareSession` output contains only allowed bootstrap fields.
- `startSession` returns a handle with `provider`, `events`, and `interrupt`.
- Optional `setModel` causes direct model switch strategy.
- Missing `setModel` causes restart-next-turn strategy.

## Event Normalization Tests

- Native assistant text maps to `assistant.message`.
- Native stream delta maps to `text.delta`.
- Native tool start maps to `tool.started`.
- Native tool result maps to `tool.completed`.
- Native success maps to `turn.complete`.
- Native failure maps to `turn.failed`.
- Native abort/interruption maps to `turn.interrupted`.
- Native usage maps to `RuntimeUsage`.
- Native session/thread id maps to `RuntimeSessionState`.

## Negative Tests Needed

- Provider emits tool failure then no terminal event.
- Provider emits assistant message after interruption.
- Provider emits terminal event without provider session state.
- Provider emits multiple assistant messages in one turn.
- Provider emits overlapping tool calls.
- Provider exits process without terminal event.
- Provider sends raw status/keepalive forever while turn is logically stuck.
