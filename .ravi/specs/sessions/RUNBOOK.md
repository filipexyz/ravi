# Sessions Runbook

## Inspecting Sessions

1. `ravi sessions list --json` — list sessions visible to the current principal,
   including effective model fields.
2. `ravi sessions info <session> --json` — inspect one session, including
   `effectiveProvider`, `effectiveModel`, `modelSource`, `modelPresetId`, and
   `modelPresetVersion`.
3. `ravi sessions actions --json` — canonical conversational action surface.

## Lifecycle

- Rename: `ravi sessions rename <session> <name>` — updates `session_name` only,
  never `session_key`.
- Reset: clears provider continuity state but preserves attach subscriptions.
- Delete: cascades to delete the session's subscriptions.

## Diagnosing Effective Model

1. Run `ravi sessions info <session> --json` and read `modelSource`.
2. `session_override` means a session `modelOverride` is shadowing the agent
   selection.
3. `agent_preset` means the effective model comes from the agent's referenced
   preset; confirm with `ravi runtime presets show <modelPresetId>`.
4. `agent_default` / `global_default` mean the agent direct model or the global
   default is in effect.

## Output Delivery

Prefer the current source chat when its subscription is `speak`; otherwise
resolve to the default output attachment when it is `speak`. If neither is
speak-enabled, the response MUST NOT emit externally.
