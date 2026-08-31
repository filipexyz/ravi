---
id: runtime/providers/grok
title: "Grok Build Runtime Provider"
kind: feature
domain: runtime
capabilities:
  - providers
  - grok
  - acp
  - rpc
tags:
  - runtime
  - grok
  - grok-build
  - coding-agent
  - acp
applies_to:
  - src/runtime/grok-provider.ts
  - src/runtime/provider-registry.ts
  - src/runtime/types.ts
  - src/runtime/provider-contract.test.ts
  - src/runtime/grok-provider.test.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Grok Build Runtime Provider

## Intent

The Grok provider adapts xAI Grok Build (`grok` CLI) into Ravi's canonical runtime provider contract. Grok Build is a local coding-agent execution engine, not a Ravi agent identity, not Grok Bot, and not the xAI chat-completions API. Ravi remains responsible for sessions, routes, permissions, traces, response delivery, and provider capability enforcement.

## Native Surface

Grok Build exposes two machine-friendly surfaces:

- ACP JSON-RPC through `grok agent stdio`: long-lived subprocess over stdin/stdout, with `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, and `session/update` notifications.
- Headless CLI through `grok -p --output-format streaming-json`: one process per prompt, with `--session-id` / `--resume` / `--continue` stored in `~/.grok/sessions`.

The MVP MUST use ACP. Headless streaming-json is a worse fit for Ravi's live session handle: it cannot keep one subprocess across turns, cannot interrupt with `session/cancel`, and forces a new process for every prompt.

## Why ACP

- Pi and Codex already use long-lived subprocess RPC. ACP is the same transport class (`subprocess-rpc`).
- `session/prompt` plus `session/update` maps onto one Ravi turn with streamed text and tool events.
- `session/load` is a documented resume path, so `supportsSessionResume` can be true without inventing file-path session state.
- `session/cancel` maps to `interrupt()` without killing the process for later turns.
- Official Grok docs present ACP as the IDE/tool integration surface and headless `-p` as the script surface.

## MVP Shape

- Provider id: `grok`.
- Integration unit: Grok Build CLI (`grok`).
- Execution mode: subprocess ACP JSON-RPC.
- Process boundary: one `grok agent stdio` process per Ravi runtime session handle.
- Command override: `RAVI_GROK_COMMAND`, same pattern as `RAVI_PI_COMMAND`.
- Spawn flags: `--no-auto-update`, `--no-alt-screen`, `--permission-mode default`, Ravi-derived `--deny` class rules, `--tools` / `--disallowed-tools` using Grok internal IDs, `--no-subagents` unless the host granted Agent/Task, optional scoped `--allow Class(pattern)` only for real scoped grants, optional `-m`, `--effort`, and `--append-system-prompt`. `--always-approve`, bare `--allow Bash` / `--allow Read`, and `--permission-mode bypassPermissions` MUST NOT be the permission model.
- Prompt submission: ACP `session/prompt` with `[{ type: "text", text }]`.
- Session state: ACP `sessionId` plus cwd and model stored in `RuntimeSessionState.params`.
- Display id: ACP `sessionId`.
- System prompt mode: append Ravi instructions through `--append-system-prompt`; do not replace Grok's base prompt.
- Tool mode: Grok uses its own built-in tools. Client ACP `fs` / `terminal` capabilities stay disabled.
- Permission mode: ravi-host. Restricted Ravi tool policy is required. Grok MUST start under least-privilege and MUST NOT use a tool Ravi did not grant.
- MCP/plugins/remote spawn: not advertised in the MVP even though `session/new` accepts `mcpServers`.

## Capability Target

Initial advertised capabilities MUST be:

- `runtimeControl`: supported with `turn.interrupt` only.
- `dynamicTools`: `none`.
- `execution`: `subprocess-rpc`.
- `sessionState`: `provider-session-id` with cwd validation.
- `usage`: `terminal-event`.
- `tools.permissionMode`: `ravi-host`.
- `tools.accessRequirement`: `tool_and_executable`.
- `tools.supportsParallelCalls`: false.
- `systemPrompt`: `append`.
- `terminalEvents`: `adapter`.
- `skillVisibility.availability`: `none`.
- `skillVisibility.loadedState`: `none`.
- `modelBroker`: `openai-completions` with `principalIsolation: none`.
- `supportsSessionResume`: true when `session/load` is advertised and a stored `sessionId` exists.
- `supportsSessionFork`: false. Grok CLI `--fork-session` MUST NOT flip this bit until canonical fork materialization exists.
- `supportsPartialText`: true.
- `supportsToolHooks`: true.
- `supportsHostSessionHooks`: false.
- `supportsPlugins`: false.
- `supportsMcpServers`: false.
- `supportsRemoteSpawn`: false.
- `toolAccessRequirement`: `tool_and_executable`.

## ACP Mapping

- `initialize` negotiates protocol version `1` and empty client fs/terminal capabilities.
- `authenticate` uses `xai.api_key` when `XAI_API_KEY` is present and advertised, otherwise `cached_token`.
- `session/new` creates a session with Ravi cwd and `mcpServers: []`.
- `session/load` resumes a stored `sessionId` when the agent advertises `loadSession`.
- `session/prompt` starts a normal Ravi-delivered user prompt.
- `session/cancel` maps to `interrupt()` and `turn.interrupt`.
- Incoming `session/request_permission` MUST be authorized by Ravi host services. Map Grok internal IDs such as `run_terminal_cmd` onto Ravi names (`Bash`). Allow only `allow_once`; reject only `reject_once`. Never select `allow_always`. Unknown tools fail closed. A shell call MUST pass both `canUseTool("Bash")` and `authorizeCommandExecution`. If authorization throws, respond JSON-RPC reject/cancelled — never swallow.
- Incoming ACP client methods other than `session/request_permission` MUST be rejected with JSON-RPC method-not-found.
- Spawn-time `--tools` / `--disallowed-tools` MUST use Grok internal IDs (`read_file`, `run_terminal_cmd`, `todo_write`, `task`, …), not class names. `--allow` / `--deny` keep Grok class/rule names. A tool grant enables the tool via `--tools` and MUST NOT emit a class-wide `--allow Bash` or `--allow Read`. Empty grants MUST still strip auto-exec tools (`todo_write`, Agent/subagents, skill invocation, command/subagent control) via a full `--disallowed-tools` catalog plus `--no-subagents`. Missing hooks fail closed.

## Event Mapping

- Handshake `sessionId` -> `thread.started`.
- Accepted Ravi prompt -> adapter-synthesized `turn.started`.
- ACP `agent_message_chunk` -> `text.delta`; accumulated text -> `assistant.message` on terminal success.
- ACP `agent_thought_chunk` -> `status: thinking`. Thought text MUST NOT become assistant output.
- ACP `tool_call` -> `tool.started`.
- ACP `tool_call_update` with `completed` or `failed` -> `tool.completed`.
- ACP `plan` -> `status: thinking`.
- ACP `usage_update.used` -> `RuntimeUsage.inputTokens` when present; otherwise zeroes.
- `session/prompt` `stopReason=end_turn` -> `turn.complete` exactly once.
- `session/prompt` `stopReason=cancelled` or host interrupt -> `turn.interrupted`.
- `session/prompt` rejection or `refusal` / token-limit stop reasons -> `turn.failed`.
- Subprocess exit or stream end before a terminal result -> recoverable `turn.failed`.

The adapter MUST emit exactly one Ravi terminal event per accepted Ravi prompt.

## Effort Mapping

Grok CLI `--effort` is documented without an enumerated Ravi-compatible set. The MVP maps:

- `none|minimal|low|medium|high` -> same native value
- `xhigh|max|ultra` -> `high`

That strongest-compatible mapping MUST stay covered by an explicit provider test.

## Invariants

- The provider MUST use strict LF-delimited JSONL. Generic line readers that split on Unicode separators are forbidden.
- The provider MUST emit `provider.raw` for every native ACP notification that is not too large or sensitive.
- The provider MUST not leak provider stderr to channel responses.
- The provider MUST terminate the Grok subprocess when the Ravi session handle is interrupted or closed.
- The provider MUST turn subprocess exit before terminal result into recoverable `turn.failed`.
- The provider MUST NOT invent Grok Bot host gateways, A2A, or chat-completions-only HTTP transports.
- The provider MUST NOT mutate Ravi tasks, emit channel messages, or add host branches in `bot.ts`, `session-launcher.ts`, or `runtime-request-builder.ts`.
- The provider MUST expose restricted Ravi agents and MUST route every Grok tool decision through Ravi host services or spawn-time allow/deny derived from those services.
- The provider MUST NOT treat `--always-approve`, `--permission-mode bypassPermissions`, or ACP auto-allow as authorization.
- The provider MUST not save ACP session ids as user-visible Ravi session names.
- The provider MUST validate cwd before resuming a Grok session.
- Native Grok `--fork-session` MUST NOT flip canonical `supportsSessionFork`.
- Tests MUST use a fake ACP transport. Live xAI calls are forbidden in CI.
