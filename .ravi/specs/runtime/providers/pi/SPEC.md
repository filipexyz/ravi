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
  - src/runtime/pi-tool-permissions.ts
  - src/runtime/provider-registry.ts
  - src/runtime/types.ts
  - src/runtime/provider-contract.test.ts
  - src/runtime/pi-provider.test.ts
  - src/runtime/pi-tool-permissions.test.ts
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
- Prompt submission: `prompt` for normal Ravi prompt delivery; `steer` for active runs and the pre-first-turn bootstrap gap through explicit runtime control; `follow_up` for active runs only.
- Steering queue mode: Ravi MUST set Pi `steeringMode=all` at session bootstrap so multiple channel messages steered during one active turn are drained together by Pi instead of becoming one assistant turn per queued message. This is not Ravi debounce; every incoming message is still sent to Pi.
- Host queue bypass: once a Ravi Pi session handle exists, interactive `after_tool` messages MUST prefer Pi native `steer` over Ravi `pendingMessages` whenever the Pi turn is active or the first prompt is still waiting to be yielded. This prevents Ravi's generator from concatenating pending human messages before Pi can apply its native steering queue.
- Session state: Pi `sessionFile`, `sessionId`, `sessionName`, cwd, model provider/id, thinking level, agent dir, and integration mode stored in `RuntimeSessionState.params`.
- Display id: `sessionName` when available, otherwise `sessionId`.
- System prompt mode: append Ravi instructions to Pi's coding-agent prompt; do not replace Pi's base prompt in the MVP.
- Tool mode: Pi still executes its own built-in tools. Ravi does not inject dynamic tools in this slice.
- Permission mode: Ravi-hosted. A Pi extension registers the in-process `tool_call` / `tool_result` hooks (Pi's `beforeToolCall` / `afterToolCall` equivalents) and asks the Ravi host over the RPC extension UI protocol before any tool executes. Restricted agents are allowed when this bridge is active.

## Capability Target

Initial advertised capabilities SHOULD be:

- `runtimeControl`: supported with `turn.steer`, `turn.interrupt`, `turn.follow_up`, `model.set`, `thinking.set`, and read/state operations that are mapped safely.
- `dynamicTools`: `none` in the MVP.
- `execution`: `subprocess-rpc`.
- `sessionState`: `file-backed` with cwd validation.
- `usage`: `terminal-event`.
- `tools.permissionMode`: `ravi-host`.
- `tools.accessRequirement`: `tool_and_executable`.
- `tools.supportsParallelCalls`: false until the adapter/host explicitly handles Pi parallel tool events.
- `systemPrompt`: `append`.
- `terminalEvents`: `adapter`.
- `supportsSessionResume`: true only when `sessionFile` and cwd are valid.
- `supportsSessionFork`: false in the MVP, even though Pi has fork/clone commands, until Ravi's fork semantics are explicitly mapped.
- `supportsPartialText`: true.
- `supportsToolHooks`: true. The RPC subprocess loads a Ravi-owned extension that blocks tools until the host answers.
- `supportsHostSessionHooks`: false in the MVP.
- `supportsPlugins`: false for Ravi plugins.
- `supportsMcpServers`: false.
- `supportsRemoteSpawn`: false.
- `toolAccessRequirement`: `tool_and_executable`.

Pi can execute tools in parallel natively, but Ravi MUST NOT advertise parallel support until host tool state stops assuming a single active tool.

## RPC Commands Mapping

- `prompt` starts a normal Ravi-delivered user prompt.
- `steer` maps to Ravi `turn.steer` when the Ravi provider handle has an active turn, or during the pre-first-turn bootstrap gap after the handle exists. If the transport has not connected yet, the provider buffers the steer and flushes it after `set_steering_mode all`, before the first `prompt`.
- `follow_up` maps to Ravi `turn.follow_up` only when the Ravi provider handle has an active turn; it is not a default prompt delivery mechanism.
- `abort` maps to `interrupt()`.
- `get_state` reads session file/id/name, streaming state, model, thinking level, and queue state.
- `set_steering_mode all` is sent during bootstrap unless `get_state` already reports `steeringMode=all`.
- `set_model` backs `setModel` and must affect the next request even if no active request exists.
- `set_thinking_level` maps Ravi effort/thinking into Pi thinking levels.
- `compact` is provider-native compaction and MUST emit `status: compacting` while active.
- `switch_session`, `new_session`, `fork`, and `clone` are provider-native controls but MUST NOT be exposed as Ravi fork/resume until session semantics are tested and mapped to `runtime/session-continuity/forks`.
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
- Pi `queue_update` -> `status: queued` while there are pending steering/follow-up messages, then `status: thinking` when the queue drains.
- Pi `compaction_start` -> `status: compacting`.
- Pi `compaction_end` -> `status: thinking` or `status: idle` depending on active state.
- Pi `auto_retry_start` / `auto_retry_end` -> `provider.raw` and status metadata.
- Pi `turn_end` with `stopReason=aborted` -> `turn.interrupted`, terminal once.
- Pi `turn_end` with `stopReason=error` -> `turn.failed`, terminal once.
- Pi `agent_end` -> `turn.complete` when no earlier terminal event was emitted for the accepted Ravi prompt.

Important: Pi `turn_end` is an internal LLM/tool-cycle boundary, not always a Ravi terminal turn. The adapter MUST emit exactly one Ravi terminal event per accepted Ravi prompt.

## Skill Visibility

- The Pi RPC MVP has no provider-native plugin or skill-loading API. Ravi
  nevertheless discovers its plugin skills, filters them by the agent
  allowlist, and appends a compact skill catalog plus
  `ravi skills show <skill> --json` loading instructions to the Pi system
  prompt.
- Current Pi state and event payloads do not expose a skill list, skill request, skill load, or skill unload event.
- Pi sessions MUST report an empty `loadedSkills` vector unless Ravi owns an explicit skill injection flow and observes completion.
- Allowlisted catalog records MUST be reported as `advertised` with declared
  `system-prompt` evidence. The adapter MUST NOT infer loaded skills from that
  appended prompt text.
- A future Pi SDK-backed provider MAY expose richer skill/resource state. That state MUST be mapped into the canonical `runtime/skill-loading` record shape before it appears in `session-visibility`.

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
- The provider MUST NOT translate normal Ravi prompt delivery into `steer` or `follow_up`, including queued channel prompts after an interrupt/requeue.
- The provider MUST tolerate the race where Pi `isStreaming` lags the `agent_end` event Ravi observes: when `prompt` is rejected with an "already processing" error, the provider MUST retry the same `prompt` with bounded exponential backoff (`100, 250, 500, 1000, 2000` ms — total ≤ 3.85s). If Pi is still busy after that budget, the provider MUST restart the RPC transport when it can and retry the same plain `prompt` once more. Only then MAY it yield `turn.failed`, and that failure MUST set `failureKind=transport` so the host treats the runtime as broken and respawns instead of `dispatch.push_existing` on the stuck process. Retries MUST remain plain `prompt` commands and MUST NOT add `streamingBehavior`, so they cannot be enqueued as `followUp` / `steer` and become orphaned or out-of-order when Pi has already drained its follow-up queue.
- After interrupt, cancel, reset, or a failed/aborted terminal, the provider MUST drain leftover RPC events, send `abort` again, and re-read `get_state`. If Pi still reports `isStreaming`, `isProcessing`, or `isCompacting`, the provider MUST restart the transport before accepting the next prompt. Leftover `agent_end` / `turn_end` from the previous run MUST NOT be accepted as the next Ravi terminal until a fresh `agent_start` or `turn_start` is observed (or the transport was respawned).
- The provider MUST reject `turn.follow_up` when there is no active Ravi turn.
- The provider MAY accept `turn.steer` before the first Ravi turn is active only to bridge the bootstrap gap where the host session already exists and the first prompt is still pending delivery.
- The provider MUST reject overlapping prompt submission unless the operation is represented as explicit active-turn control.
- When the host receives a normal human prompt while a provider turn is active and the delivery barrier is `after_tool`, the host MAY use canonical `turn.steer` instead of abort/requeue. This decision belongs in the host dispatcher/control layer, not inside Pi prompt submission.
- The provider MUST route every Pi tool decision through Ravi host services (`canUseTool`, and for shell `authorizeCommandExecution`) before the tool executes. Missing handlers, thrown authorization, unknown dialogs, and unresolved observation/unconditional Bash denials MUST fail closed.
- The provider MUST treat `tools.permissionMode=ravi-host` as a live-bridge contract, not a static advertisement. After spawning RPC with `--extension`, it MUST wait for the extension handshake (`extension_ui_request` notify `ravi.permission.hooks.ready` from `session_start`) before sending any `prompt`. Missing handshake, a Ravi-extension `extension_error`, a `tool_execution_start` before handshake, or a transport that cannot write `extension_ui_response` MUST fail closed: no prompt, no tool.started, and a `turn.failed` with `failureKind=transport`. Advertising `ravi-host` while running an ungoverned Pi session is forbidden.
- The provider MUST keep Pi model/provider secrets out of the tool-sharing RPC process env even after `supportsToolHooks` is true. Secret injection remains a follow-up until Pi can isolate model credentials from tool env.
- The provider MUST NOT advertise Ravi dynamic tools, parallel tool support, or host-session PreToolUse hooks in this slice. Tool-level skill gates that only run on Claude `PreToolUse` remain open unless the call is Bash command authorization.
- Crash-recovery MUST keep Pi on `toolEffectFence=provider_event_only` until a durable PreToolUse-equivalent ACK is proven. The permission bridge authorizes before execution; it does not yet replace that fence.
- The provider MUST not save Pi session file paths as user-visible Ravi session names.
- The provider MUST validate cwd before resuming a Pi session file.
- Pi native fork/clone MUST NOT flip canonical `supportsSessionFork` until file-backed parent/child state, prompt atom mapping, and replay semantics are tested.

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

## Permission Hook Bridge

This slice keeps the RPC JSONL execution path (prompt, steer, interrupt, resume). It does not migrate sessions onto `createAgentSession`.

Ravi MUST materialize a Pi extension and spawn RPC with `--extension <path>`. That extension:

- emits `ctx.ui.notify("ravi.permission.hooks.ready", "info")` on `session_start` so the host can prove the bridge is live;
- listens for `tool_call` (blocking, before execution) and `tool_result` (observational after);
- asks the host with `ctx.ui.confirm("ravi.permission.request", <json>)`;
- blocks the tool unless the host confirms.

Pi continues after a failed `--extension` load. That is why the handshake is required: fail-closed host answers do not help if `tool_call` never registered. The adapter MUST NOT send `prompt` until the handshake is observed (or a matching `extension_error` / pre-handshake `tool_execution_start` fails the session). The RPC adapter MUST answer `extension_ui_request` on stdin with `extension_ui_response` without waiting for a command `response`. Map Pi names (`bash`, `read`, `write`, `edit`) onto Ravi REBAC names (`Bash`, `Read`, `Write`, `Edit`). A shell call MUST pass both `canUseTool("Bash")` and `authorizeCommandExecution`. Authorization throws become deny. Unrelated extension dialogs MUST be cancelled.

This is not a split policy: Pi-native tools still execute inside Pi, but every call is authorized by Ravi before execution. Provider-native leftovers are execution, session files, compaction, and the skill catalog prompt — not permission decisions.

## Later SDK Path

A later SDK-backed Pi provider MAY replace or complement RPC. SDK integration remains the right place for:

- Ravi dynamic tools as Pi custom tools.
- In-process `beforeToolCall` / `afterToolCall` without the extension UI hop.
- Direct session manager integration.
- Lower latency and fewer subprocess lifecycle edge cases.
- Richer control over resources, skills, and prompt composition.
- Tool-level skill gates that today depend on Claude `PreToolUse`.
