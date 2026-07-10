# Agents Checks

## Visibility Checks

- `agents list --json` under runtime context MUST include the current agent and
  agents covered by `view agent:<id>`, and MUST exclude others.
- `agents show <hidden-agent> --json` MUST NOT reveal hidden agent configuration.
- Agent route inspection MUST NOT disclose hidden agent config to a principal
  that lacks `view agent:<id>`.
- A superadmin executor invoked by an untrusted contact MUST NOT expose hidden
  agents solely because the executor has broad grants.

## Model Preset Checks

- Assigning `modelPreset` MUST clear the direct `model` in one transaction.
- Writing a direct `model` MUST clear `modelPresetId` in one transaction.
- A provider write incompatible with a referenced preset MUST fail with an
  actionable error before commit.
- `agents show <id> --json` MUST expose `effectiveProvider`, `effectiveModel`,
  `modelSource`, `modelPresetId`, and `modelPresetVersion`.
- Assigning a missing or disabled preset MUST fail and MUST NOT fall back to the
  global default silently.

## Commands

- `bun test src/cli/commands/agents.test.ts`
- `bun test src/router/router.test.ts`
