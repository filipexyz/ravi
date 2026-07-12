# Runtime Model Presets Checks

## Commands

```bash
ravi runtime presets create fast-sonnet --provider anthropic --model sonnet --json
ravi runtime presets list --json
ravi runtime presets show fast-sonnet --json
ravi runtime presets set fast-sonnet model sonnet-4 --dry-run --json
ravi runtime presets set fast-sonnet model sonnet-4 --json
ravi runtime presets impact fast-sonnet --json
ravi runtime presets disable fast-sonnet --json
ravi runtime presets enable fast-sonnet --json
ravi runtime presets delete fast-sonnet --dry-run --json
ravi agents set dev modelPreset fast-sonnet
ravi agents set dev model sonnet-4
ravi agents show dev --json
```

## Focused Tests

```bash
bun test src/runtime/model-preset-store.test.ts
bun test src/cli/commands/runtime-presets.test.ts src/cli/commands/agents.test.ts
bun test src/tasks/runtime-options.test.ts
```

## Persistence Checks

- Create/list/show/enable/model-update persist and validate every field.
- Persisted `model`/`enabled` mutations increment `version` exactly once.
- A model no-op update returns the current preset without bumping the version.
- Duplicate ids fail before commit with an actionable next command.
- `agents.model_preset_id` is nullable and indexed.

## Resolution Checks

- Two agents referencing one preset resolve the same effective model without a
  model selector stored on either agent row.
- Direct `model` and `modelPresetId` are mutually exclusive in one transaction;
  clearing both falls through to the global default.
- Missing/disabled/provider-incompatible preset references fail before commit
  without silent global fallback.
- Legacy agents without a preset preserve current behavior exactly.
- Session, prompt/dispatch, task, and profile overrides win over the preset and
  are reported as shadowing.
- Legacy drift (direct model + preset) prefers the direct model and emits a
  warning/trace.

## Dry-Run Checks

- Dry-run returns the same paginated affected/shadowed set as the real mutation
  but changes no version, timestamps, agent rows, or config-change events.

## Runtime / Observability Checks

- A real model update emits `ravi.config.changed` after commit; the next
  unshadowed turn uses direct-set or restart-next-turn and traces `agent_preset`
  plus the new version.
- Referenced presets cannot be disabled/deleted; unreferenced presets can.
- Agent/session JSON includes effective provider/model/source/id/version.

## Schema Checks

```bash
bun src/cli/index.ts sdk returns validate --strict --json
bun src/cli/index.ts sdk openapi check --against docs/openapi.json --json
bun src/cli/index.ts sdk client check --json
```

- Every finite `runtime presets` command declares `@CommandAccess`, a concrete
  `@Returns` schema, and supports `--json`.
- No newly weak public return schemas are introduced.
