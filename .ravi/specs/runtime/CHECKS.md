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
- Internal `turn.failed` diagnostics retain the raw error while channel responses, live-state summaries, waited CLI errors, and observation prompts omit local paths, runtime exception details, and credential-shaped values.
- Provider inactivity requests interruption before the runtime transport closes.
- Ambiguous inactivity recovery preserves the logical delivery id and marks only the active turn for reconciliation.
- A second consecutive inactivity for the same session is suppressed, traced, and sent to the operator alert path instead of the user channel.

## Compaction Announcements

- A human/channel turn with `announceCompaction` enabled and normal (non-sentinel) mode emits the external compaction start/end announcements.
- A cron-originated turn (`_cron`) with a reply source emits no external compaction announcement.
- A trigger-originated turn (`_trigger`) with a reply source emits no external compaction announcement.
- A session-followup-originated turn (`_sessionFollowup`) with a resolved source emits no external compaction announcement.
- Heartbeat and other automation-originated turns compact silently externally.
- Every origin still records runtime status, the `runtime.status` trace for `compacting=true` and `compacting=false`, live state, and skill visibility reset when applicable.
- The origin decision is produced by the centralized runtime classifier, not by scattered prompt-marker checks in the event loop.

## Queue Semantics

- Messages yielded to a provider turn remain pending until terminal completion.
- Interrupted turns keep pending messages.
- Non-interrupted terminal turns clear yielded pending ids.
- Unsafe tool abort defers until tool completion.
- After-task barriers remain blocked while an active task binding exists.
- A pending start waiting for runtime pool capacity is tracked separately from an actual cold start.
- Subsequent prompts for a pending-start session are stashed with a pending-start reason, not `cold_start_inflight`.
- Runtime pool backpressure trace events use the canonical session key when the session exists.
- Background/task starts respect reserved interactive capacity; interactive starts may use that reserved capacity.
- Ambiguous recovery keeps its delivery id and does not batch later fresh prompt atoms into the replay.

## Provider Logs

- Provider stderr remains buffered for crash diagnostics even when selected lines
  are not forwarded as WARN daemon logs.
- Known benign Codex skill loader and MCP cleanup warnings are debug-only; real
  provider errors and unknown warnings remain visible.

## Gaps To Close Before Adding Another Provider

- Add a capability for native runtime control operations instead of assuming only one provider supports them.
- Add a capability for dynamic tool calls.
- Add a capability for system prompt mode: append, override, or provider-composed.
- Add a capability for session storage mode: provider id, thread id, file path, or opaque params.
- Add tests for "tool result but no terminal event" recovery.
- Add tests for multiple assistant messages preserving response boundaries.
- Add tests or explicit unsupported status for parallel tool calls.
