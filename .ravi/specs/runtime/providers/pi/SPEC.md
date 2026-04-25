---
id: runtime/providers/pi
title: "Pi Runtime Provider"
kind: feature
domain: runtime
capabilities:
  - providers
  - pi
  - rpc
  - runtime-control
tags:
  - runtime
  - pi
  - coding-agent
  - rpc
applies_to:
  - src/runtime/pi-provider.ts
  - src/runtime/provider-registry.ts
  - src/runtime/types.ts
  - src/runtime/provider-contract.test.ts
  - src/runtime/pi-provider.test.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Pi Runtime Provider

## Intent

The Pi provider adapts `pi-coding-agent` into Ravi's canonical runtime provider contract. Pi is an execution engine, not a Ravi agent identity. Ravi remains responsible for sessions, routes, permissions, traces, response delivery, and provider capability enforcement.

## Native Surface

Pi exposes two integration surfaces:

- RPC JSONL through `pi --mode rpc`: subprocess boundary over stdin/stdout, with typed commands and streamed agent events.
- Native SDK through `@mariozechner/pi-coding-agent`: direct `createAgentSession`, `AgentSessionRuntime`, tools, hooks, session manager, and event subscription.

The MVP MUST use RPC JSONL. The SDK path MAY replace or complement RPC after the runtime contract is validated.

## MVP Shape

- Provider id: `pi`.
- Integration unit: `pi-coding-agent`.
- Execution mode: subprocess RPC JSONL.
- Process boundary: one Pi RPC process per Ravi runtime session handle.
- Prompt submission: `prompt` for a new idle turn; `steer` or `follow_up` for active runs only through explicit runtime control.
- Session state: Pi `sessionFile`, `sessionId`, `sessionName`, cwd, model provider/id, thinking level, agent dir, and integration mode stored in `RuntimeSessionState.params`.
- Display id: `sessionName` when available, otherwise `sessionId`.
- System prompt mode: append Ravi instructions to Pi's coding-agent prompt; do not replace Pi's base prompt in the MVP.
- Tool mode: Pi uses its own built-in tools in the MVP.
- Permission mode: restricted Ravi tool policy is unsupported in the MVP and MUST be rejected by capability checks.

## Capability Target

Initial advertised capabilities SHOULD be:

- `runtimeControl`: supported with `turn.steer`, `turn.interrupt`, `turn.follow_up`, `model.set`, `thinking.set`, and read/state operations that are mapped safely.
- `dynamicTools`: `none` in the MVP.
- `execution`: `subprocess-rpc`.
- `sessionState`: `file-backed` with cwd validation.
- `usage`: `terminal-event`.
- `tools.permissionMode`: `provider-native` in the MVP.
- `tools.accessRequirement`: `tool_and_executable`.
- `tools.supportsParallelCalls`: false until the adapter/host explicitly handles Pi parallel tool events.
- `systemPrompt`: `append`.
- `terminalEvents`: `adapter`.
- `supportsSessionResume`: true only when `sessionFile` and cwd are valid.
- `supportsSessionFork`: false in the MVP, even though Pi has fork/clone commands, until Ravi's fork semantics are explicitly mapped.
- `supportsPartialText`: true.
- `supportsToolHooks`: false in the MVP.
- `supportsHostSessionHooks`: false in the MVP.
- `supportsPlugins`: false for Ravi plugins.
- `supportsMcpServers`: false.
- `supportsRemoteSpawn`: false.
- `toolAccessRequirement`: `tool_and_executable`.

Pi can execute tools in parallel natively, but Ravi MUST NOT advertise parallel support until host tool state stops assuming a single active tool.

## RPC Commands Mapping

- `prompt` starts a new user prompt when Pi is idle.
- `steer` maps to Ravi `turn.steer` when Pi is streaming.
- `follow_up` is not a default prompt delivery mechanism; use only when Ravi explicitly wants after-idle queuing.
- `abort` maps to `interrupt()`.
- `get_state` reads session file/id/name, streaming state, model, thinking level, and queue state.
- `set_model` backs `setModel` and must affect the next request even if no active request exists.
- `set_thinking_level` maps Ravi effort/thinking into Pi thinking levels.
- `compact` is provider-native compaction and MUST emit `status: compacting` while active.
- `switch_session`, `new_session`, `fork`, and `clone` are provider-native controls but MUST NOT be exposed as Ravi fork/resume until session semantics are tested.
- `get_messages` and `get_last_assistant_text` may support `thread.read`-style controls.

## Event Mapping

- Pi `agent_start` -> `provider.raw`; adapter MAY synthesize `thread.started` once after `get_state`.
- Pi `turn_start` -> `turn.started`.
- Pi `message_start` -> `item.started`.
- Pi `message_end` -> `item.completed`; if assistant text is final, also `assistant.message`.
- Pi `message_update` with `text_delta` -> `text.delta`.
- Pi `message_update` with `thinking_delta` -> `provider.raw` and optional `status: thinking`; do not emit hidden reasoning text as assistant output.
- Pi `tool_execution_start` -> `tool.started`.
- Pi `tool_execution_update` -> `provider.raw` in the MVP.
- Pi `tool_execution_end` -> `tool.completed`.
- Pi `compaction_start` -> `status: compacting`.
- Pi `compaction_end` -> `status: thinking` or `status: idle` depending on active state.
- Pi `auto_retry_start` / `auto_retry_end` -> `provider.raw` and status metadata.
- Pi `turn_end` with `stopReason=aborted` -> `turn.interrupted`, terminal once.
- Pi `turn_end` with `stopReason=error` -> `turn.failed`, terminal once.
- Pi `agent_end` -> `turn.complete` when no earlier terminal event was emitted for the accepted Ravi prompt.

Important: Pi `turn_end` is an internal LLM/tool-cycle boundary, not always a Ravi terminal turn. The adapter MUST emit exactly one Ravi terminal event per accepted Ravi prompt.

## Usage Mapping

Pi assistant messages include usage fields:

- `usage.input` -> `RuntimeUsage.inputTokens`
- `usage.output` -> `RuntimeUsage.outputTokens`
- `usage.cacheRead` -> `RuntimeUsage.cacheReadTokens`
- `usage.cacheWrite` -> `RuntimeUsage.cacheCreationTokens`

If usage is missing on an error or abort, terminal events MUST still be emitted. Successful `turn.complete` MUST include a valid usage object, using zeroes only when Pi explicitly reports no usage.

## Invariants

- The provider MUST use strict LF-delimited JSONL. Generic line readers that split on Unicode separators are forbidden.
- The provider MUST emit `provider.raw` for every native event that is not too large or sensitive.
- The provider MUST not leak provider stderr to channel responses.
- The provider MUST terminate the Pi subprocess when the Ravi session handle is interrupted or closed.
- The provider MUST turn subprocess exit before terminal result into recoverable `turn.failed`.
- The provider MUST reject overlapping prompt submission unless the operation is represented as `turn.steer` or follow-up control.
- The provider MUST not expose restricted Ravi agents until Pi tool permission hooks are bridged to Ravi host services.
- The provider MUST not save Pi session file paths as user-visible Ravi session names.
- The provider MUST validate cwd before resuming a Pi session file.

## Pre-Implementation Requirements

Implement these generic Ravi changes before building the Pi adapter:

1. Keep `RuntimeCapabilities` structured and explicit for every provider. This first cut is implemented.
2. Update compatibility checks so restricted agents are blocked from providers without Ravi-controlled tool hooks. Implemented through `tools.permissionMode`.
3. Add a generic terminality helper for provider streams and subprocess lifecycles. Implemented through `RuntimeTerminalEventTracker`.
4. Decide whether host tool tracking supports parallel tools or whether the Pi adapter must serialize/squash tool events. MVP decision: advertise `supportsParallelCalls=false` and keep events serial in Ravi.
5. Add a generic provider-session-state validator for file-backed session state and cwd matching. Implemented through `validateRuntimeSessionState`.
6. Extend runtime control types or provider control metadata to represent Pi controls that do not fit the current fixed operation set. First cut implemented with `session.*`, `turn.follow_up`, `model.set`, and `thinking.set`.
7. Add a fake Pi RPC transport for provider tests. Implemented in `src/runtime/pi-provider.test.ts`.

## Implementation Plan

### Phase 0 - Runtime Contract Foundation

- Extend the generic capability contract.
- Populate current provider matrices without changing current runtime behavior.
- Make restricted-tool compatibility depend on `tools.permissionMode`.
- Persist structured capability summaries in runtime traces.

### Phase 1 - Generic Runtime Hardening

- Add terminality helper shared by subprocess-style providers.
- Add file-backed session-state validation.
- Define host behavior for parallel tool events.
- Add provider contract test helpers for fake providers.

### Phase 2 - Pi RPC Adapter

- Implement strict JSONL RPC transport. Implemented in the first adapter cut.
- Normalize Pi events into Ravi runtime events. Implemented for lifecycle, text, assistant message, tools, status, usage, and terminal events.
- Implement interrupt, model set, thinking set, and safe state reads. Implemented through handle/control methods.
- Emit exactly one terminal event per accepted Ravi prompt. Implemented through the shared terminality tracker.

### Phase 3 - Dev-Only Rollout

- Register provider id `pi` behind explicit config only.
- Create one dev agent/session using `provider=pi`.
- Validate text, tool, interrupt, resume, and model/thinking switch flows before exposing to task workers.

## Later SDK Path

After the RPC MVP passes, Ravi MAY add an SDK-backed Pi provider variant. SDK integration is the right place for:

- Ravi dynamic tools as Pi custom tools.
- Ravi permission policy through Pi `beforeToolCall` / `afterToolCall` hooks.
- Direct session manager integration.
- Lower latency and fewer subprocess lifecycle edge cases.
- Richer control over resources, skills, and prompt composition.
