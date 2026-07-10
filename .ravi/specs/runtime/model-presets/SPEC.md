---
id: runtime/model-presets
title: "Runtime Model Presets"
kind: capability
domain: runtime
capabilities:
  - model-presets
tags:
  - runtime
  - model
  - presets
  - agents
applies_to:
  - src/runtime/model-preset-store.ts
  - src/runtime/model-preset-resolver.ts
  - src/cli/commands/runtime-presets.ts
  - src/cli/commands/agents.ts
  - src/tasks/runtime-options.ts
  - src/runtime/task-runtime-context.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Model Presets

## Intent

Runtime model presets are centrally managed, named model selectors that agents
reference indirectly. A preset carries a stable id/slug, an immutable provider,
a model selector, an enabled flag, and a monotonic version. Agents store only a
reference (`agents.model_preset_id`); the preset model selector is never copied
into agent rows. Changing a preset updates every referencing agent's effective
model without rewriting agent, session, task, dispatch, or profile state.

## Data Model

- `runtime_model_presets(id, provider, model, description, enabled, version,
  created_at, updated_at)`; `version` starts at 1 and increments exactly once per
  persisted `model` or `enabled` mutation.
- `agents.model_preset_id` is nullable, indexed, and references a preset by id.
- A direct agent `model` and `model_preset_id` are mutually exclusive on the
  agent row.

## Normative Requirements

- MUST persist a preset reference on each agent; MUST NOT materialize/copy the
  preset model selector into agent rows.
- MUST validate preset existence, enabled state, provider compatibility, and the
  model selector before any durable effect.
- MUST publish `ravi.config.changed` only after a durable commit.
- MUST preserve per-field precedence, highest first:
  1. prompt/dispatch override
  2. task override
  3. profile runtime default
  4. session override
  5. agent preset or direct agent model
  6. global default
- MUST NOT mutate session, task, dispatch, or profile state to apply a preset.
- MUST keep direct `model` and `modelPresetId` mutually exclusive on every
  supported create/update/set path. Legacy drift (both fields set) MUST prefer
  the direct `model` and emit an observable warning/trace.
- MUST reject missing, disabled, or provider-incompatible preset references
  without silent global fallback.
- MUST block disable/delete for referenced presets and return paginated
  dependencies plus an actionable correction command.
- MUST keep the preset provider immutable in this first version.
- MUST expose concrete public Zod return schemas through `@Returns`; newly weak
  schemas MUST remain empty and `@CliOnly()` MUST NOT be used.
- SHOULD expose `modelSource=agent_preset`, `modelPresetId`, and
  `modelPresetVersion` in JSON output and runtime traces.
- MAY retain direct agent model configuration as compatibility and an escape
  hatch.

## Canonical Resolution

`resolveAgentModelSelection` / `resolveEffectiveAgentModel`
(`src/runtime/model-preset-resolver.ts`) are the single source of truth for
agent-level model resolution. They return `effectiveProvider`, `effectiveModel`,
`modelSource`, `modelPresetId`, and `modelPresetVersion`, and are reused by the
agent CLI, session resolution, task runtime options, and the session dispatcher
rather than duplicating precedence logic.

## Runtime Behavior

- A preset model update does not rewrite agents/sessions/tasks and does not
  interrupt an in-flight turn.
- After commit, the mutation emits the existing config refresh signal
  (`ravi.config.changed`).
- On the next unshadowed turn, the runtime compares the effective model and uses
  the existing direct-set or restart-next-turn strategy, tracing `agent_preset`
  and the preset version.
