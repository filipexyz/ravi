---
id: runtime/providers/codex
title: "Codex Runtime Provider"
kind: feature
domain: runtime
capabilities:
  - providers
  - codex
  - cli-context
  - runtime-control
tags:
  - runtime
  - codex
  - cli
  - app-server
applies_to:
  - src/runtime/codex-provider.ts
  - src/runtime/codex-hooks.ts
  - src/runtime/codex-hook-guard.ts
  - src/plugins/codex-skills.ts
  - src/runtime/codex-provider.test.ts
  - src/runtime/codex-hooks.test.ts
  - src/runtime/codex-mcp-isolation.ts
  - src/runtime/codex-mcp-isolation.test.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Codex Runtime Provider

## Intent

The Codex provider adapts the Codex app-server transport into Ravi's canonical runtime contract while preserving Ravi-owned permissions, CLI context, session state, traces, and response delivery.

## Current Shape

- Provider id: `codex`.
- Execution mode: subprocess app-server JSON-RPC transport.
- Fallback transport: JSON CLI exec exists in code but the app-server path is the active rich integration.
- Session state: thread/session id plus cwd in `RuntimeSessionState.params`.
- Resume: supported only when stored cwd matches current cwd. Ambiguous delivery recovery resumes the same thread and reconciles the logical delivery id before any replay.
- Fork: not supported by provider capabilities, even though native control can fork threads operationally. Canonical fork requires the `runtime/session-continuity/forks` materializer to map Codex threads/turns back to Ravi prompt atoms.
- Partial text: supported through `agent_message.delta`.
- Dynamic tools: disabled. Ravi CLI registry commands MUST NOT be advertised as Codex native dynamic tools.
- Ravi CLI access: model-initiated Ravi operations MUST go through shell commands such as `ravi tasks ...` or `bin/ravi tasks ...` with `RAVI_CONTEXT_KEY` in the shell env.
- Shell env bridge: the Codex app-server receives Ravi runtime env and is launched with an explicit `shell_environment_policy` that allows the shell to inherit only core shell env plus `RAVI_*`, including `RAVI_CONTEXT_KEY`.
- Approvals: mapped into Ravi `RuntimeApprovalRequest`.
- Runtime control: thread list/read/rollback/fork, turn interrupt, and goal get/set/clear through `ravi sessions runtime`. The provider also implements `turn.steer`, used only by the host dispatcher for implicit native steer; the host refuses an explicit `turn.steer`/`turn.follow_up` with `RUNTIME_CONTROL_DISABLED` until the durable attempt-input journal exists (`daemon/restart/crash-recovery`), and host-facing operation lists report them under `disabledOperations`.
- Tool access requirement: `tool_surface`.
- Host session hooks/plugins/spec server/remote spawn: not supported.
- MCP: Codex's own MCP servers are disabled at launch. Registered servers
  (`mcp`) are reached only through `ravi mcp tools` and
  `ravi mcp call --execute` in the shell tool, under the same
  `use:tool:mcp__<server>__<tool>` check as every runtime.

## Event Mapping

- `thread/started` -> `thread.started`
- `turn/start` response -> `turn.started` binding when the response carries the native turn before a notification
- `turn/started` -> `turn.started`
- `item/started` -> `item.started` and optionally `tool.started`
- `item/completed` -> `item.completed`, `assistant.message`, and optionally `tool.completed`
- `item/agentMessage/delta` -> `text.delta`
- `turn/completed` completed -> `turn.complete` when the logical delivery is finished; an active goal emits a non-terminal `turn.goal_continuation` raw event and retains the consumer for the next native turn
- `turn/completed` interrupted -> `turn.interrupted`
- `turn/completed` other status -> `turn.failed`
- JSON-RPC approval request -> `approval.requested` / `approval.resolved`
- JSON-RPC dynamic tool call -> defensive synthetic `item.started` / `item.completed` plus protocol-safe semantic failure. It MUST NOT execute a Ravi CLI registry command.

## Native goal controls

`goal.get/set/clear` map to the experimental app-server `thread/goal/get/set/clear` API, documented at https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal. They operate on the same persisted goal as native model tools and `/goal`. Updates without an objective preserve native accounting; `createOnly` reads the existing goal before attempting creation.

Native `budgetLimited`/`usageLimited` map to `budget_limited`/`usage_limited`; native timestamps in seconds map to Unix milliseconds. Full goal notifications and resume snapshots emit canonical `goal.updated` events. A malformed response MUST fail explicitly.

Stored goal control initializes an experimental app-server connection without `thread/start` or `thread/resume`, sends the metadata RPC, then closes the connection. It MUST NOT load the thread: setting an active goal on a loaded idle thread can start native work immediately. Opaque session params preserve a custom `CODEX_HOME` locator for stored control.

## Skill Visibility

- Codex skills are provider-native files under the Codex skills directory. Ravi synchronizes plugin-backed skills during `prepareSession` through `syncCodexSkills`.
- `syncCodexSkills` proves `synced`, not `loaded`.
- The Codex system prompt catalog proves `advertised`, not `loaded`.
- App-server `skills/list` MAY be used to refresh `available` skill metadata for one or more cwds. `skills/changed` MUST be treated as metadata invalidation and SHOULD trigger a later `skills/list` refresh when visibility needs fresh metadata.
- `UserInput` entries with `type=skill` prove a requested skill reference. They MUST be recorded as `requested` unless a later provider signal proves the skill content was loaded.
- Thread start/resume `instructionSources` MAY prove loaded instruction files for a thread. The adapter MAY mark a skill `loaded` only if an instruction source path is matched to a canonical `SKILL.md` path for that skill.
- Codex currently has no stable dedicated `skill.loaded` notification in the app-server event stream. Until one exists or `instructionSources` are matched to canonical skill paths, Codex MUST expose synchronized Ravi skills as `synced`/`advertised` and keep `loadedSkills` empty.

## Invariants

- The provider MUST initialize or resume one native thread before starting a turn.
- The provider MUST pass the stable logical delivery id as `clientUserMessageId` on `turn/start`.
- The provider MUST capture the native turn id from the `turn/start` response even when `turn/started` is delayed or absent.
- The live Codex session handle MUST advertise `ambiguousTurnRecoveryStrategy=reconcile_by_client_message_id`.
- Before replaying an ambiguously delivered turn on resume, the provider MUST reconcile `clientUserMessageId`: hydrate a completed match, reattach to an in-progress match, or inspect an interrupted/failed match. It MAY fork immediately before that terminal turn and replay once only when the host supplied terminal replay authority; otherwise it MUST terminate reconciliation without a second `turn/start`.
- The provider MUST NOT issue a second `turn/start` for an ambiguous delivery before reconciliation finishes. A legacy exact-prompt fallback MAY match only the newest native turn that lacks a client id.
- The provider MUST NOT start overlapping turns on one app-server transport.
- The provider MUST NOT send Ravi dynamic tool definitions to Codex.
- The provider MUST NOT route Codex app-server dynamic tool calls through `hostServices.executeDynamicTool`.
- The provider MUST pass Ravi-owned runtime env, including `RAVI_CONTEXT_KEY`, into the Codex app-server process.
- A reused Codex app-server process MUST be respawned before the next turn when its Ravi env signature differs from the current runtime env.
- The provider MUST launch the Codex app-server with `shell_environment_policy.inherit=all`, `shell_environment_policy.ignore_default_excludes=true`, and an `include_only` glob allowlist that includes `RAVI_*` plus minimal core shell variables. This is required because Codex default shell env exclusions can strip env names containing `KEY`.
- The global Codex Bash hook command MUST resolve to a stable Ravi CLI entrypoint such as `bin/ravi` or the bundled CLI, never to a test file or transient runner script.
- Generated hooks MUST emit `ravi context codex-bash-hook` as the preferred command. They MUST NOT emit `codex-tool-hook` as the preferred command.
- The CLI MUST accept `ravi context codex-tool-hook` as a deprecated alias of `codex-bash-hook` with the same access and payload so stale `~/.codex/hooks.json` files and in-memory Codex workers cannot hard-block Bash, including `ravi pages list|published|publish`.
- The global Codex Bash hook matcher MUST be exactly `^(Bash|shell)$`. It MUST cover both Codex tool names currently observed for shell execution: `Bash` and `shell`.
- Rematerializing hooks MUST replace legacy Ravi groups (old status `ravi codex native tool permission gate`, old command `codex-tool-hook`, or a non-canonical matcher) instead of appending a second group beside them.
- Writing `hooks.json` MUST NOT count as proof that the Bash gate runs. Before starting, resuming or forking a thread on a real `codex` app-server, Ravi MUST call `hooks/list` for the session cwd and require exactly one Ravi gate from the generated file: same command, matcher `^(Bash|shell)$`, event `preToolUse`, enabled, not async. An untrusted gate is trusted for its exact current hash only (`config/batchWrite` of `hooks.state.<key>.trusted_hash`) and listed again. When any of this cannot be confirmed (including a Codex without `hooks/list`), the session MUST fail closed before `thread/start` with an error that says the gate is unverified. Ordinary sessions send `features.hooks=true` and the legacy `features.codex_hooks=true`.
- A reused Codex app-server process MUST be respawned before the next turn when `hooks.json` changes. Thread/resume MUST keep session history.
- The global Codex Bash hook MUST enforce Ravi shell permissions and runtime skill gates only. It MUST NOT rely on `PreToolUse.updatedInput` to inject env because current Codex rejects unsupported updated input for this hook.
- Ravi provider-owned grants such as `full-access` authorize Ravi's permission layer only. They MUST NOT be documented as a bypass for provider-native hooks, global Codex hooks, or external PreToolUse transforms that may still deny a shell command after Ravi allows it.
- The shell env bridge MUST NOT print or embed `RAVI_CONTEXT_KEY` directly in user-visible command text or traces.
- Ravi operations requested by the model MUST execute through the shell/CLI path under the current Ravi context.
- Command/file/permission/user-input approval requests MUST route through Ravi approval handlers.
- An unexpected dynamic tool JSON-RPC response MUST always include normalized `contentItems`; missing output MUST become text fallback, but the semantic result MUST remain a failed tool event.
- A completed native turn without an active goal MUST produce `turn.complete` with provider session state.
- Goals are thread-scoped. The adapter MUST track `thread/goal/updated` and `thread/goal/cleared` independently of physical turn ids and probe `thread/goal/get` on resume with a bounded timeout for older servers.
- While a goal is active, successful physical turn completion MUST NOT close the event queue, mark the host idle, release the logical delivery, or inject another `turn/start`. Codex owns automatic continuation. Successor events MUST retain native thread/turn metadata under the same logical Ravi delivery.
- The adapter MUST accept a successor only on the bound thread after a completed predecessor; late predecessor and child-thread events MUST remain excluded.
- Usage for completed physical goal turns MUST be accumulated into the logical terminal usage. A paused, cleared, blocked, limited, or completed goal MUST release a delivery waiting between physical turns. A failed or interrupted native turn MUST terminate immediately, even when goal state remains active.
- Start/resume notifications MUST remain buffered until the explicit `turn/start` response binds the accepted native turn. An automatic resume turn MUST NOT seize the incoming delivery before that binding.
- A native interrupted turn or interrupt request MUST produce `turn.interrupted`, not `turn.failed`, unless the native process actually fails before interruption can be established.
- A native exit without terminal event MUST become recoverable `turn.failed`. When Codex sent no error event, the failure MUST carry `failureKind=transport` whatever stderr holds, and an app-server connection that drops before the exit is observed MUST end the same way. Failures before the connection is ready (a missing executable, no listener) are setup errors and MUST NOT be classified as transport.
- The provider MUST NOT leak provider stderr to channel responses. The `turn.failed` error MUST be stable text (`Codex CLI exited without a terminal event (code N | signal S)`); the ANSI-stripped stderr tail, exit code and signal go only to logs and the failure `rawEvent` that the trace records.
- The `turn/interrupt` timeout fallback (SIGINT, then SIGKILL after the grace) MUST signal only the process that ran the interrupted turn, and only while that turn is still the active one. Settling the turn, starting the next turn or closing the transport MUST cancel a pending kill from an earlier interrupt.
- The provider MUST include metadata with thread, turn, and item ids whenever the native event carries them.
- The provider MUST sync Codex skills during `prepareSession` and include the skill catalog in provider instructions.
- Codex `thread.fork` MUST remain a provider-native runtime control until a canonical fork materializer proves parent/child thread mapping, optional child rollback, prompt atom replay, and provider state persistence.
- A provider-local fork used only to recover one failed ambiguous turn MUST NOT advertise canonical `supportsSessionFork`.

## MCP Isolation

- The provider MUST read the `[mcp_servers]` keys of every configuration
  layer Codex loads for the session: `/etc/codex/config.toml`,
  `/etc/codex/managed_config.toml`, `$CODEX_HOME/config.toml` (default
  `<HOME>/.codex`), and the project layers `<dir>/.codex/config.toml` for each
  folder from the project root (the nearest ancestor holding `.git`, else the
  cwd) down to the cwd. A project layer counts only when its folder is
  trusted: the folder's own `[projects."<path>"] trust_level` decides, and
  without one the git root's entry decides. Codex does not load an untrusted
  layer, and an override for a key no loaded layer defines makes Codex refuse
  to start.
- For each key the provider MUST append `-c mcp_servers.<key>.enabled=false`
  to the app-server launch arguments, and `-c features.apps=false` to turn
  Codex's apps (connectors) feature off, also when no server is configured.
  `-c mcp_servers={}` MUST NOT be relied on: Codex merges tables, so it does
  not clear configured servers.
- Codex splits a `-c` key path on every dot and does not read quotes, so only
  keys matching `^[A-Za-z0-9_-]+$` can be turned off. Any other key MUST fail
  the session start closed, before Codex runs, with an error that names the
  key and its file and points to `ravi mcp import`. One exported test,
  `isCodexOverridableMcpKey`, decides it, for the launch and for `ravi
  doctor`'s warning about such an entry (spec mcp); one exported walk,
  `collectCodexMcpConfigSources`, lists the layers and their keys for both.
- A leading UTF-8 byte order mark is dropped before a file is parsed (Bun's
  TOML parser reads such a file as an empty table). Bun's parser also rejects
  valid TOML that Codex accepts (offset and local date-times, local dates,
  local times, on Bun 1.3; Bun 1.4 accepts them), so when it throws, a strict
  line scan reads the file instead:
  every `[mcp_servers.<key>...]` and `[[mcp_servers.<key>...]]` header,
  every dotted `mcp_servers.<key>.` assignment (at the top level or under
  `[mcp_servers]`), the keys of a top-level `mcp_servers = { ... }` inline
  table, bare, basic-quoted and literal-quoted keys, and the
  `[projects."<path>"] trust_level` strings, while skipping strings of all
  four kinds, arrays and inline tables over several lines, comments and bare
  values (whitespace around a value, before a comment or the line's end, is a
  space or a tab, as in TOML). A line the scan cannot place, or a shape it cannot read
  (`mcp_servers` that is not a table, `projects` as an inline table), means
  it cannot decide.
- A configuration file that exists but cannot be read, that neither the
  parser nor the scan can read, or whose `mcp_servers` is not a table, MUST
  fail the session start closed, with an error naming the file and saying
  that Ravi could not read it (never that the file is invalid); it MUST NOT
  be read as "no servers". A file with no MCP server at all simply works.
- After `thread/start`, `thread/resume` and `thread/fork` (including the fork
  that recovers an ambiguous turn), the provider MUST call
  `mcpServerStatus/list` with the thread id (`detail: "toolsAndAuthOnly"`,
  following `nextCursor`, bounded wait). Codex still lists a disabled server,
  with `runtimeStatus: "disabled"` and no tools; any entry with another or a
  missing status, or with tools, MUST fail the session closed with an error
  that names the server(s) and points to `ravi mcp import`. An error, a
  timeout or an answer without a `data` list MUST fail the session closed; a
  failed call (a Codex too old to answer it, for example) says the check was
  verified on Codex 0.172.0 and to update Codex, without guessing the
  installed version. No
  `turn/start` is sent before the check passes. The call MUST carry the thread
  id: without it Codex reloads its configuration without the project layers.
- An `item/mcpToolCall/*` event, or an `item/started|completed` item of the MCP
  tool call type, MUST fail the turn closed and stop the app-server process:
  Codex is not supposed to have an MCP tool, so such a call reached no Ravi
  decision. The error names the server, never the arguments.
- The launch overrides are part of the app-server respawn decision: a change
  in the configured keys MUST respawn a reused app-server before the next
  turn.
- The global Bash hook and its `^(Bash|shell)$` matcher are unchanged by MCP
  isolation.
- Codex isolation uses the operator's Codex home, not a private
  `CODEX_HOME` per agent, so Codex login refresh and native thread resume keep
  working.
- A thread forked by the native `thread.fork` runtime control is not checked;
  no turn of this session runs on it until a later start or resume, which is.

## Validation

- `bun test src/runtime/codex-mcp-isolation.test.ts`
- `bun test src/runtime/codex-provider.test.ts`
- `bun test src/runtime/codex-hooks.test.ts`
- `bun test src/runtime/public-failure.test.ts`
- `bun test src/runtime/provider-contract.test.ts`
- `bun test src/runtime/model-catalog.test.ts`
- `bun test src/plugins/codex-skills.test.ts`
- `bun test src/runtime/session-trace.test.ts`

## Known Failure Modes

- Dynamic tool call response shape changes can make the native runtime keep waiting after the tool completes; `contentItems` is the app-server contract.
- Reaction-only or silent turns can finish natively but remain active in Ravi if `turn.complete` is not normalized.
- Native raw events may continue while the logical turn is stuck; missing `turn/completed` is an adapter/runtime bug, not normal completion.
- A dropped callback after `turn/start` creates an ambiguous delivery outcome. Resume reconciliation and the host circuit breaker MUST prevent duplicate starts and unbounded recovery loops.
- Synthetic and native dynamic tool item events can both appear from unexpected app-server requests; the adapter MUST dedupe canonical tool lifecycle by tool call id and keep the request non-operational.
- The app-server transport rejects overlapping turns; dispatcher must queue/interrupt instead of yielding concurrent prompts.
- Synthetic tool starts are needed when a completed item arrives without a previous start.
- Cwd mismatch on stored session state must disable resume to avoid attaching to the wrong native thread.
- Model provider/model metadata may be absent and must not break terminal persistence.
- If a shell command cannot see `RAVI_CONTEXT_KEY`, treat it as a runtime/tool-boundary bug. Do not compensate by re-enabling Codex native dynamic tools.
- Runtime control/capability metadata regressions can break dispatcher decisions; `RuntimeCapabilities` coverage must stay aligned with provider behavior.
- A server enabled in Codex configuration after the thread started, or brought
  by a Codex plugin the overrides do not name, is caught only by the next
  start's status check or by the MCP tool call rule.
- Skill sync can be mistaken for loaded state. The adapter MUST not populate `loadedSkills` from `syncCodexSkills` or prompt catalog text alone.
