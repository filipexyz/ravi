# Codex Provider Checks

## Required Tests

- App-server thread start emits `thread.started`.
- App-server turn start emits `turn.started`.
- Agent message delta emits `text.delta`.
- Agent message completion emits `assistant.message`.
- Command execution item emits tool start/end.
- Dynamic tool call emits synthetic tool start/end and returns normalized content.
- Approval request emits requested/resolved events and returns provider-compatible decision.
- Completed turn emits `turn.complete` with session state `{ sessionId, cwd }`.
- Interrupted turn emits `turn.interrupted`.
- Native failure emits recoverable `turn.failed`.
- Native process exit without terminal event emits recoverable `turn.failed`.
- `turn/start` sends the stable delivery id as `clientUserMessageId` and captures the native turn from the JSON-RPC response.
- Resuming an ambiguous completed turn hydrates its existing items and terminal state without a second `turn/start`.
- Resuming an ambiguous in-progress turn reattaches and consumes notifications without a second `turn/start`.
- Resuming an ambiguous interrupted/failed turn forks immediately before that native turn and replays once on the fork.

## Regression Cases

- Dynamic tool handler throws.
- Dynamic tool handler returns no content.
- Dynamic tool handler returns image content.
- Tool completion arrives without item start.
- `turn/interrupt` is requested before the native turn id is known.
- Stored session cwd differs from current cwd.
- Model is omitted because default model should be native default.
- Native thread id exists but provider session params are missing.
- A resume response followed immediately by terminal notifications is buffered and reconciled without losing events.
