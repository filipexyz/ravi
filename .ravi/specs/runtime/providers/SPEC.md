---
id: runtime/providers
title: "Runtime Providers"
kind: capability
domain: runtime
capabilities:
  - providers
tags:
  - runtime
  - provider-contract
  - adapters
applies_to:
  - src/runtime/types.ts
  - src/runtime/provider-registry.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/runtime-provider-bootstrap.ts
  - src/runtime/host-event-loop.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Providers

## Intent

Runtime providers are adapters from a native execution engine into Ravi's canonical runtime. They allow Ravi to use multiple engines while preserving one host lifecycle, one permission model, one trace model, and one response pipeline.

## Provider Contract

A provider MUST implement:

- `id`: stable runtime provider id.
- `getCapabilities()`: explicit matrix of supported host features.
- `startSession(RuntimeStartRequest)`: returns a live `RuntimeSessionHandle`.

A provider MAY implement:

- `prepareSession(...)`: bootstrap env, dynamic tools, or approval handlers before `RuntimeStartRequest` is built.
- `interrupt()`: terminate or interrupt an active turn.
- `setModel(model)`: live model switch.
- `control(request)`: provider-native runtime controls such as thread read, fork, rollback, steer, or interrupt.

The host dispatcher MAY route a concurrent human prompt through `control({ operation: "turn.steer" })` when the active handle supports runtime control and the delivery barrier is `after_tool`. If control fails or is unsupported, the host MUST fall back to the normal Ravi queue/interruption path without losing the prompt.

Host-side debounce and provider-native steering are different layers:

- Debounce is a pre-runtime UX batching decision controlled by agent/channel config.
- Runtime `pendingMessages` is the host delivery queue used after a session handle exists.
- Provider-native `turn.steer` is a control operation for injecting an additional prompt into an existing native run.

Adapters with native steering MAY bypass Ravi `pendingMessages` for interactive `after_tool` messages after a live handle exists, but MUST NOT disable debounce unless the agent/channel config says so.

## Model Selectors

Agent `model` values are provider-specific strings, but Ravi MUST still reject selectors that are structurally invalid before saving config. Validation belongs in the runtime model catalog/provider-local code, not scattered across unrelated CLIs.

Minimum validation:

- Reject empty model values.
- Reject whitespace in model values.
- Reject malformed `provider/model` selectors with an empty provider or model segment.
- For Pi, reject known provider ids used alone as model selectors, such as `kimi-coding`; use `kimi-coding/kimi-for-coding` instead.

Deep validation against a live provider catalog or credentials MAY be implemented as explicit preflight, but MUST NOT be required for every config write unless the provider can do it cheaply and deterministically.

## Canonical Events

Providers MUST normalize native output into:

- `thread.started`
- `turn.started`
- `item.started`
- `item.completed`
- `text.delta`
- `status`
- `assistant.message`
- `tool.started`
- `tool.completed`
- `approval.requested`
- `approval.resolved`
- `turn.interrupted`
- `turn.failed`
- `turn.complete`

Providers MAY emit `provider.raw` for observability, but raw events MUST NOT be consumed as source of truth by product logic.

## Capability Matrix

Legacy compatibility fields still exposed:

- `supportsSessionResume`
- `supportsSessionFork`
- `supportsPartialText`
- `supportsToolHooks`
- `supportsHostSessionHooks`
- `supportsPlugins`
- `supportsMcpServers`
- `supportsRemoteSpawn`
- `toolAccessRequirement`
- `legacyEventTopicSuffix`

Structured capabilities every provider MUST expose:

- `runtimeControl`: whether provider control is supported and which operations are accepted.
- `dynamicTools`: whether the provider can call Ravi-provided dynamic tools.
- `execution`: whether the provider runs through SDK, subprocess RPC, subprocess CLI, embedded code, or external service.
- `sessionState`: whether provider state is absent, session-id, thread-id, file-backed, or external-store.
- `usage`: whether token usage arrives on terminal events, streams incrementally, or is unavailable.
- `tools`: Ravi permission mode, required unrestricted access level, and parallel tool support.
- `systemPrompt`: append, override, or provider-composed prompt behavior.
- `terminalEvents`: whether terminal events are provider-guaranteed or adapter-enforced.
- `skillVisibility`: how the provider exposes skill availability, synchronization, advertisement, request, and loaded-state evidence.

The legacy fields remain until downstream call sites are migrated. New provider decisions MUST prefer structured fields.

## Pre-Pi Requirements

Before implementing the Pi adapter, Ravi SHOULD harden these generic runtime surfaces:

- Keep `RuntimeCapabilities` structured fields explicit for every provider. This first cut is implemented.
- Make the launcher reject incompatible agents from capability data instead of provider name checks. This is implemented for restricted tool access through `tools.permissionMode`.
- Make terminal-event recovery generic: subprocess exit, stream end, or accepted prompt without terminal result MUST become `turn.failed` or `turn.interrupted`. This is implemented by `RuntimeTerminalEventTracker`.
- Decide how the host event loop represents parallel tool execution, because Pi can execute tools concurrently while Ravi currently tracks one active tool in session state.
- Define generic file-backed provider session state, including cwd validation, session file paths, and display ids. This is implemented by `validateRuntimeSessionState`.
- Keep restricted tool access disabled for providers that do not route tool decisions through Ravi host services. This is enforced by compatibility checks.
- Add provider contract fixtures that run without live model calls. This is implemented for Pi through an injectable fake RPC transport.

## Integration Plan

1. Runtime contract foundation: structured capabilities, explicit provider matrices, and compatibility checks based on capabilities.
2. Terminality foundation: one generic helper that converts stream exit, subprocess exit, abort, or missing terminal result into exactly one terminal Ravi event.
3. Session-state foundation: generic validation for file-backed provider sessions, including cwd matching and safe display ids.
4. Tool-event foundation: keep Pi advertised as non-parallel until the host model supports parallel tool state; adapter must serialize/squash observable tool events if needed.
5. Pi RPC MVP: subprocess JSONL transport, fake transport tests, event normalization, interrupt, model/thinking controls, and resume state. The first adapter cut is implemented.
6. Dev rollout: explicit `provider=pi` on one dev agent only, text prompt E2E, tool prompt E2E, interrupt/resume/model-switch E2E.

## Invariants

- Provider adapters MUST NOT emit channel messages directly.
- Provider adapters MUST NOT mutate Ravi tasks or sessions directly, except through canonical terminal state returned to the host event loop.
- Provider adapters MUST NOT bypass Ravi permission policy.
- Provider adapters MUST NOT require provider-specific branches outside registry, model catalog, or provider-local files.
- Provider adapters MUST include enough metadata for trace correlation: provider, native event, thread id when available, turn id when available, item id when available.
- A provider that supports restricted tool access MUST route permission decisions through Ravi host services or host hooks.
- A provider that cannot support restricted access MUST declare that through capabilities so the launcher can reject incompatible agents.
- A provider that supports resume MUST return a `RuntimeSessionState` on `turn.complete`.
- A provider that supports fork MUST define how parent provider state maps into the child session.
- A provider that supports control MUST reject unsafe control operations while an active turn is running.
- `turn.steer` means “inject this into the active native run”; `turn.follow_up` means “run this after the active native run would otherwise stop”. CLIs and UIs MUST expose both semantics distinctly.
- A provider MUST NOT report a skill as loaded unless it can expose observed evidence or Ravi completed an explicit provider injection flow.
- A provider that cannot expose skill-loading evidence MUST declare that through `skillVisibility` and return conservative `session-visibility` state.

## Validation

- `bun test src/runtime/provider-contract.test.ts`
- `bun test src/runtime/*provider.test.ts`
- `bun test src/runtime/runtime-session-continuity.test.ts`
- `bun test src/runtime/model-switch.test.ts`
- `bun test src/runtime/session-trace.test.ts`
- `bunx tsc --noEmit --pretty false`

## Known Failure Modes

- Provider ID checks spread into host runtime modules.
- A provider emits native success but no canonical `turn.complete`.
- Provider state is saved from a raw event before the turn actually completes.
- Tool approval succeeds in provider-native code while Ravi policy would deny it.
- Provider-native session ids are treated as user-visible session names.
- A provider with no hook support is started for an agent that needs restricted tools.
- A provider with no control support receives `sessions runtime` commands and fails silently.
- Model switching is implemented by provider name instead of handle strategy.
- Provider capability data says skills are supported, but session visibility can only prove local sync or prompt advertisement.
