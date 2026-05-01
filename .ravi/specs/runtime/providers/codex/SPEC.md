---
id: runtime/providers/codex
title: "Codex Runtime Provider"
kind: feature
domain: runtime
capabilities:
  - providers
  - codex
  - dynamic-tools
  - runtime-control
tags:
  - runtime
  - codex
  - tools
  - app-server
applies_to:
  - src/runtime/codex-provider.ts
  - src/plugins/codex-skills.ts
  - src/runtime/codex-provider.test.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Codex Runtime Provider

## Intent

The Codex provider adapts the Codex app-server transport into Ravi's canonical runtime contract while preserving Ravi-owned permissions, dynamic tools, session state, traces, and response delivery.

## Current Shape

- Provider id: `codex`.
- Execution mode: subprocess app-server JSON-RPC transport.
- Fallback transport: JSON CLI exec exists in code but the app-server path is the active rich integration.
- Session state: thread/session id plus cwd in `RuntimeSessionState.params`.
- Resume: supported only when stored cwd matches current cwd.
- Fork: not supported by provider capabilities, even though native control can fork threads operationally.
- Partial text: supported through `agent_message.delta`.
- Dynamic tools: supported through app-server `item/tool/call`.
- Approvals: mapped into Ravi `RuntimeApprovalRequest`.
- Runtime control: thread list/read/rollback/fork and turn steer/interrupt.
- Tool access requirement: `tool_surface`.
- Host session hooks/plugins/spec server/remote spawn: not supported.

## Event Mapping

- `thread/started` -> `thread.started`
- `turn/started` -> `turn.started`
- `item/started` -> `item.started` and optionally `tool.started`
- `item/completed` -> `item.completed`, `assistant.message`, and optionally `tool.completed`
- `item/agentMessage/delta` -> `text.delta`
- `turn/completed` completed -> `turn.complete`
- `turn/completed` interrupted -> `turn.interrupted`
- `turn/completed` other status -> `turn.failed`
- JSON-RPC approval request -> `approval.requested` / `approval.resolved`
- JSON-RPC dynamic tool call -> synthetic `item.started` / `item.completed` plus dynamic tool response.

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
- The provider MUST NOT start overlapping turns on one app-server transport.
- The provider MUST send Ravi dynamic tool definitions only after `prepareSession` obtains host services.
- Dynamic tool calls MUST route through `hostServices.executeDynamicTool`.
- Command/file/permission/user-input approval requests MUST route through Ravi approval handlers.
- A dynamic tool JSON-RPC response MUST always include normalized `contentItems`; missing output MUST become text fallback.
- A completed native turn MUST produce `turn.complete` with provider session state.
- A native interrupted turn or interrupt request MUST produce `turn.interrupted`, not `turn.failed`, unless the native process actually fails before interruption can be established.
- A native exit without terminal event MUST become recoverable `turn.failed`.
- The provider MUST include metadata with thread, turn, and item ids whenever the native event carries them.
- The provider MUST sync Codex skills during `prepareSession` and include the skill catalog in provider instructions.

## Validation

- `bun test src/runtime/codex-provider.test.ts`
- `bun test src/runtime/provider-contract.test.ts`
- `bun test src/runtime/model-catalog.test.ts`
- `bun test src/plugins/codex-skills.test.ts`
- `bun test src/runtime/session-trace.test.ts`

## Known Failure Modes

- Dynamic tool call response shape changes can make the native runtime keep waiting after the tool completes; `contentItems` is the app-server contract.
- Reaction-only or silent turns can finish natively but remain active in Ravi if `turn.complete` is not normalized.
- Native raw events may continue while the logical turn is stuck; missing `turn/completed` is an adapter/runtime bug, not normal completion.
- Synthetic and native dynamic tool item events can both appear; the adapter MUST dedupe canonical tool lifecycle by tool call id.
- The app-server transport rejects overlapping turns; dispatcher must queue/interrupt instead of yielding concurrent prompts.
- Synthetic tool starts are needed when a completed item arrives without a previous start.
- Cwd mismatch on stored session state must disable resume to avoid attaching to the wrong native thread.
- Model provider/model metadata may be absent and must not break terminal persistence.
- Dynamic tools currently return mostly text through host services; richer content paths need explicit tests.
- Runtime control/capability metadata regressions can break dispatcher decisions; `RuntimeCapabilities` coverage must stay aligned with provider behavior.
- Skill sync can be mistaken for loaded state. The adapter MUST not populate `loadedSkills` from `syncCodexSkills` or prompt catalog text alone.
