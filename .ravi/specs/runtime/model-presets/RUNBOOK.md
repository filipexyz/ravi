# Runtime Model Presets Runbook

## Create A Preset

```bash
ravi runtime presets create fast-sonnet --provider anthropic --model sonnet --json
ravi runtime presets show fast-sonnet --json
```

Creation validates the id/slug, provider, and model selector before commit and
emits `ravi.config.changed` after commit. Duplicate ids fail with an actionable
next command.

## Assign A Preset To An Agent

```bash
ravi agents create dev ~/ravi/dev --provider anthropic --model-preset fast-sonnet
ravi agents set dev modelPreset fast-sonnet
ravi agents set dev modelPreset clear   # release the reference
```

Assigning a preset clears any direct `model` on the agent in one transaction.
Writing a direct `model` clears the preset:

```bash
ravi agents set dev model sonnet-4   # clears modelPresetId atomically
```

Assigning a disabled, missing, or provider-incompatible preset fails before any
durable effect.

## Inspect Impact

```bash
ravi runtime presets impact fast-sonnet --json
ravi runtime presets impact fast-sonnet --limit 20 --offset 20 --json
```

Impact returns the paginated referencing agents, per-agent shadowing session
counts, totals, and a correction command. Session/prompt/dispatch/task/profile
overrides continue to win and are reported as shadowing the preset.

## Rotate A Preset Model

```bash
ravi runtime presets set fast-sonnet model sonnet-4 --dry-run --json
ravi runtime presets set fast-sonnet model sonnet-4 --json
```

A dry-run returns the same affected/shadowed set as the real mutation but bumps
no version, changes no rows, and emits no config-change event. A real update
bumps the version exactly once, emits `ravi.config.changed`, and the next
unshadowed turn applies the new model via direct-set or restart-next-turn.

## Rollback

```bash
ravi runtime presets set fast-sonnet model sonnet --json   # set back to prior model
```

Rolling back is a normal model update: it bumps the version and re-emits the
config-change signal. Prefer forward rollback over editing rows directly.

## Enable / Disable / Delete

```bash
ravi runtime presets disable fast-sonnet --dry-run --json
ravi runtime presets disable fast-sonnet --json
ravi runtime presets enable fast-sonnet --json
ravi runtime presets delete fast-sonnet --json
```

Referenced presets cannot be disabled or deleted; the command returns the
paginated dependencies and an actionable correction command. Reassign the
referencing agents first.

## Diagnose `modelSource`

```bash
ravi agents show dev --json        # effectiveModel, modelSource, modelPresetId, modelPresetVersion
ravi sessions info <session> --json
```

- `modelSource=agent_preset` → the effective model came from the assigned preset.
- `modelSource=agent_default` → the agent uses a direct model.
- `modelSource=session_override` → a session model override shadows the agent.
- `modelSource=global_default` → no agent-level or session model is set.

If an agent shows both a direct model and a preset (legacy drift), the direct
model is preferred and a warning is traced.
