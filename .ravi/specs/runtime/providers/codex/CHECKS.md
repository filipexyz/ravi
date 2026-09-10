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
- Resuming an ambiguous interrupted/failed turn forks and replays once only with host terminal replay authority; an unsafe recovery emits a terminal interruption without `thread/fork` or `turn/start`.

## Regression Cases

- Generated `hooks.json` command contains `codex-bash-hook` and does not contain `codex-tool-hook`.
- `ravi context codex-tool-hook` is a registered alias of `codex-bash-hook`.
- Doctor fails on a stale `codex-tool-hook` command and on a matcher other than `^(Bash|shell)$`.
- Rematerialize replaces a legacy wide-matcher `codex-tool-hook` group instead of leaving it in place.
- Dynamic tool handler throws.
- Dynamic tool handler returns no content.
- Dynamic tool handler returns image content.
- Tool completion arrives without item start.
- `turn/interrupt` is requested before the native turn id is known.
- Stored session cwd differs from current cwd.
- Model is omitted because default model should be native default.
- Native thread id exists but provider session params are missing.
- A resume response followed immediately by terminal notifications is buffered and reconciled without losing events.

## Automatic goals

- `bun test src/runtime/codex-provider.test.ts --test-name-pattern "Codex automatic goal continuation"`
- Assert delayed native successors still deliver messages and tools without a second `turn/start`.
- Assert late predecessor terminals and child thread events cannot close the goal delivery.
- Assert complete/pause/interruption/failure produce exactly one logical terminal; completed physical turn usage is accumulated.
- Assert resumed automatic events cannot override the explicit input turn binding.
- For live validation, compare native rollout physical turn ids with Ravi provider raw/item/tool events across a goal continuation. Do not publish production rollout contents or identifiers.

Protocol reference: https://learn.chatgpt.com/docs/app-server (thread goals and turn events). Validate generated bindings with the installed Codex version via `codex app-server generate-ts --experimental --out <temporary-directory>`.
