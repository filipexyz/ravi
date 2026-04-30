---
id: runtime/providers/claude-code
title: "Claude Code Runtime Provider"
kind: feature
domain: runtime
capabilities:
  - providers
  - claude-code
  - host-hooks
  - plugins
  - spec-mode
tags:
  - runtime
  - default-provider
  - hooks
  - mcp
applies_to:
  - src/runtime/*provider.ts
  - src/runtime/host-hooks.ts
  - src/runtime/runtime-host-attachments.ts
  - src/runtime/*provider.test.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Claude Code Runtime Provider

## Intent

The Claude Code provider adapts the current default cloud execution bridge into Ravi's canonical runtime contract. It is the richest existing provider for host hooks, plugins, spec mode, remote spawn, session resume, and session fork.

## Current Shape

- Provider id: current default cloud runtime.
- Execution mode: provider query bridge.
- Session state: native session id in `RuntimeSessionState.params`.
- Resume: supported.
- Fork: supported.
- Partial text: supported through stream delta events.
- Tool hooks: supported through provider-native hook integration.
- Host session hooks: supported.
- Plugins: supported.
- Spec server: supported through MCP attachment.
- Remote spawn: supported.
- Dynamic tools through Ravi host services: not supported in the same path as Codex.
- Runtime control operations: no provider-native `control()` handle today.
- Live model switch: supported through `setModel` on active query when available, with fallback to next turn.

## Event Mapping

- Stream text delta -> `text.delta`
- Status system event -> `status`
- Assistant text block -> `assistant.message`
- Assistant tool-use block -> `tool.started`
- User tool-result block -> `tool.completed`
- Successful result -> `turn.complete`
- Non-success result -> `turn.failed`
- Query exception -> recoverable `turn.failed`
- Stream end without a terminal result -> recoverable `turn.failed` (desired contract; current code must be audited when this path is changed)

## Invariants

- The provider MUST pass Ravi `systemPromptAppend` as additional system instructions.
- The provider MUST pass Ravi-owned env into the native query environment.
- The provider MUST use Ravi `canUseTool` for tool permission decisions.
- The provider MUST attach host hooks only when capabilities allow it.
- The provider MUST attach spec server only for spec-mode agents.
- The provider MUST attach remote spawn only for remote agents.
- A successful result MUST produce `turn.complete` with session id and usage.
- A non-success result MUST produce `turn.failed`.
- A query exception MUST become recoverable `turn.failed`, not an unhandled event-loop error.
- A provider stream that ends without a terminal result MUST become recoverable `turn.failed`.
- `setModel` MUST update current and subsequent turns; if native live switch fails, the next query MUST still use the requested model.

## Validation

- `bun test src/runtime/*provider.test.ts`
- `bun test src/runtime/provider-contract.test.ts`
- `bun test src/runtime/host-env.test.ts`
- `bun test src/runtime/runtime-host-attachments.test.ts`
- `bun test src/runtime/session-trace.test.ts`

## Known Failure Modes

- Provider-native tool result is missing or malformed, leaving Ravi with `tool.start` and no `tool.end`.
- Query throws after an interrupt and Ravi misclassifies it as a user-facing failure.
- Provider emits text/tool events but no terminal result, leaving the turn active until the adapter converts stream end into `turn.failed`.
- Host exit-plan logic still reads a provider-specific plan directory; future providers need an explicit plan artifact/control contract instead of host hardcoding.
- Provider-specific settings files are created during prepare but not captured as explicit runtime bootstrap state.
- Host hooks are available here but not in Codex, which can hide permission behavior differences.
- Runtime controls are unavailable even though the sessions CLI exposes a generic control surface.
- Raw events lack consistent thread/turn/item metadata compared with Codex, reducing trace correlation.
- The model catalog is alias-based and provider-specific instead of a generic provider model registry.
