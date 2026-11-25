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
- A Codex session whose `hooks/list` lacks the Ravi gate, or shows it changed, disabled, async or untrusted after the trust write, fails before `thread/start`; a confirmed gate is checked before `thread/start` and the turn runs.
- Dynamic tool handler throws.
- Dynamic tool handler returns no content.
- Dynamic tool handler returns image content.
- Tool completion arrives without item start.
- `turn/interrupt` is requested before the native turn id is known.
- Stored session cwd differs from current cwd.
- Model is omitted because default model should be native default.
- Native thread id exists but provider session params are missing.
- A resume response followed immediately by terminal notifications is buffered and reconciled without losing events.
- A process exit without a terminal event and with ANSI tracing output on stderr yields `failureKind=transport` with stable error text; the stderr tail appears only in `rawEvent.message`, without escapes.
- A dropped app-server connection (`CodexAppServerTransportError`) yields a recoverable transport `turn.failed`, not a thrown session error.
- A `turn/interrupt` that never answers, for a turn that already ended, does not signal the process running the next turn.
- `publicRuntimeFailureDetail` turns tracing lines, Rust `::` paths, thread-store errors and Codex exit/connection diagnostics into the generic message, strips control characters and redacts UUIDs in what stays visible.

## MCP Isolation

- `bun test src/runtime/codex-mcp-isolation.test.ts src/runtime/codex-provider.test.ts`
- Launch arguments from a fixture home `config.toml` and a trusted project
  `.codex/config.toml` hold one `-c mcp_servers.<key>.enabled=false` per key
  (a quoted bare key included) plus `-c features.apps=false`; no
  `-c mcp_servers={}`. System and managed layers add their keys.
- An untrusted project's keys are left out; with a git root, every trusted
  folder from the root to the cwd adds its keys, a folder's own trust entry
  wins over the root's, and without a git root an ancestor's trust is not
  inherited.
- A key `-c` cannot address (`"my.server"`), an unreadable file and a
  malformed file each fail the start closed with "Ravi could not read", and
  the app-server is never spawned for a malformed file.
- The scan is tested through a parser that rejects every file (the reader
  and `resolveCodexMcpIsolation` take the parser as a parameter), so it runs
  on any Bun: which valid TOML Bun's own parser rejects changes between
  releases. Valid TOML with offset and local date-times, local dates and
  local times is read either way: a file without servers works, and servers in
  headers, dotted keys, quoted keys, an inline `mcp_servers = {...}` table,
  `[mcp_servers]` subtables and `[[...]]` headers are all turned off; a
  string over several lines that looks like a header is not a server; trust
  from a scanned file is kept. A BOM is dropped. A bare value followed by a
  tab (`x = 1<TAB># note`) is read, not refused. A line the scan cannot place
  fails closed (`src/runtime/codex-mcp-isolation.test.ts`).
- `mcpServerStatus/list` reporting a server that is not disabled aborts the
  session with an error that names it and `ravi mcp import`, and no
  `turn/start` is sent; an empty answer or all-disabled entries pass; an error
  from the call aborts, naming Codex 0.172.0 and the update; a later page is
  followed.
- A simulated `item/mcpToolCall/*` event and an `item/started` item of type
  `mcpToolCall` each fail the turn; the error carries no argument values.
- A configured key added between turns respawns the app-server with the new
  override.
- The generated Bash hook matcher stays `^(Bash|shell)$`.
- Live check (`mcp` RUNBOOK, done on Codex 0.172.0): the overrides and the
  apps switch leave every configured server `disabled` in the status list.

## Automatic goals

- `bun test src/runtime/codex-provider.test.ts --test-name-pattern "Codex automatic goal continuation"`
- Assert delayed native successors still deliver messages and tools without a second `turn/start`.
- Assert late predecessor terminals and child thread events cannot close the goal delivery.
- Assert complete/pause/interruption/failure produce exactly one logical terminal; completed physical turn usage is accumulated.
- Assert resumed automatic events cannot override the explicit input turn binding.
- For live validation, compare native rollout physical turn ids with Ravi provider raw/item/tool events across a goal continuation. Do not publish production rollout contents or identifiers.

Protocol reference: https://learn.chatgpt.com/docs/app-server (thread goals and turn events). Validate generated bindings with the installed Codex version via `codex app-server generate-ts --experimental --out <temporary-directory>`.
