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

## Overlay voice panel and release order

The WhatsApp overlay voice panel (`postAgentTtsSettings`) sends only its TTS
keys as a defaults patch and relies on the daemon merging per key (#1052,
`agents set <id> defaults`). A daemon older than that release replaces the
whole defaults object, so a voice save there would erase the agent's other
defaults, including `runtimePermissions` (27/11 incident on `main`).

- Install the release that contains #1052 on the daemon (`ravi update --next`,
  then `ravi channels restart`) before loading an overlay built from a checkout
  that contains this panel.
- After a voice save, `ravi agents permissions <id>` must still show the
  profile, and `audit_log` (`agent.updated`) must list only `tts_*` keys.
- If a voice save ever erases defaults, restore the profile with
  `ravi agents permissions <id> <profile> --execute` from the operator terminal
  and read the `agent.updated` row for the actor.
