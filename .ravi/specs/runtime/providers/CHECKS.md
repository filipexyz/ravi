# Runtime Providers Checks

## Contract Tests

- Provider exposes stable id.
- Capability matrix includes every required capability key.
- `prepareSession` output contains only allowed bootstrap fields.
- `startSession` returns a handle with `provider`, `events`, and `interrupt`.
- Optional `setModel` causes direct model switch strategy.
- Missing `setModel` causes restart-next-turn strategy.
- Model-specific option normalization omits unsupported native options.
- Adaptive-thinking-only models do not receive disabled-thinking payloads when Ravi canonical input is `thinking=off`.

## Reasoning Effort Tests

- Canonical effort MUST accept `max` and `ultra` and reject unknown values with a clear error before provider handoff.
- Codex exec transport MUST pass `max`/`ultra` through as `model_reasoning_effort` and MUST NOT rename the model.
- Codex app-server `thread/start` and `thread/resume` MUST carry `config.model_reasoning_effort` for `max`/`ultra`.
- Any `xhigh -> max` strongest-compatible mapping MUST be covered by an explicit provider test.
- A model with no catalog pricing entry MUST be reported as unpriced with zero cost.

## Event Normalization Tests

- Native assistant text maps to `assistant.message`.
- Native stream delta maps to `text.delta`.
- Native tool start maps to `tool.started`.
- Native tool result maps to `tool.completed`.
- Native success maps to `turn.complete`.
- Native failure maps to `turn.failed`.
- Native abort/interruption maps to `turn.interrupted`.
- Native usage maps to `RuntimeUsage`.
- Native session/thread id maps to `RuntimeSessionState`.

## Negative Tests Needed

- Provider emits tool failure then no terminal event.
- Provider emits assistant message after interruption.
- Provider emits terminal event without provider session state.
- Provider emits multiple assistant messages in one turn.
- Provider emits overlapping tool calls.
- Provider exits process without terminal event.
- Provider sends raw status/keepalive forever while turn is logically stuck.

## SDK/Model Update Checks

- Provider SDK version supports the model selector being exposed.
- Direct peer dependencies required by the provider SDK are satisfied.
- New model aliases are covered by provider-local tests.
- Pricing is available through the model catalog or explicitly marked unknown.
- New model capability differences are recorded in provider capability data or a covered provider-local compatibility shim.

## Model Preset Checks

- A preset model selector validates against its immutable provider before commit.
- A referenced preset resolves `effectiveProvider` to the preset provider.
- A preset model update applies on the next turn via direct-set or
  restart-next-turn and traces `agent_preset` plus the new version.
