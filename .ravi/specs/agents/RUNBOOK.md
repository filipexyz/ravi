# Agents Runbook

## Inspecting Agents

1. `ravi agents list --json` — list agents visible to the current principal.
2. `ravi agents show <id> --json` — inspect one agent, including effective model
   fields (`effectiveProvider`, `effectiveModel`, `modelSource`,
   `modelPresetId`, `modelPresetVersion`).

## Configuring An Agent Model

- Direct model: `ravi agents set <id> model <selector>`. This clears any
  `modelPresetId` in the same transaction.
- Referenced preset: `ravi agents set <id> modelPreset <preset>`. This clears
  the direct `model` in the same transaction.
- Clear a preset: `ravi agents set <id> modelPreset clear` — the agent falls
  through to its direct `model` or the global default.
- Create with a preset: `ravi agents create <id> <cwd> --model-preset <preset>`.

## Diagnosing Effective Model

1. Run `ravi agents show <id> --json` and read `modelSource`.
2. `agent_preset` means the effective model comes from a referenced preset;
   confirm the preset with `ravi runtime presets show <modelPresetId>`.
3. `agent_default` means the direct agent `model` is in effect.
4. `global_default` means neither a preset nor a direct model is set.

## Provider Conflicts

If a provider write fails because it is incompatible with a referenced preset,
either clear the agent provider or assign a preset whose provider matches.
