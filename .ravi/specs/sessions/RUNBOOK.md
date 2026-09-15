# Sessions Runbook

## Inspecting Sessions

1. `ravi sessions list --json` — list sessions visible to the current principal,
   including effective model fields.
2. `ravi sessions info <session> --json` — inspect one session, including
   `effectiveProvider`, `effectiveModel`, `modelSource`, `modelPresetId`, and
   `modelPresetVersion`.
3. `ravi sessions recap <session> --json` — bounded computed recap (identity,
   goal if present, empty structured fields, recent user/assistant tail).
4. `ravi sessions actions --json` — canonical conversational action surface.

## Lifecycle

- Rename: `ravi sessions rename <session> <name>` — updates `session_name` only,
  never `session_key`.
- Reset: clears provider continuity state but preserves attach subscriptions.
- Delete: cascades to delete the session's subscriptions.
- Attach/detach: `session_chat_subscriptions` is the only ledger. After
  `ravi sessions detach`, a leftover `session_chat_bindings` row MUST NOT
  exist or come back on the next process start.

## Diagnosing Effective Model

1. Run `ravi sessions info <session> --json` and read `modelSource`.
2. `session_override` means a session `modelOverride` is shadowing the agent
   selection.
3. `agent_preset` means the effective model comes from the agent's referenced
   preset; confirm with `ravi runtime presets show <modelPresetId>`.
4. `agent_default` / `global_default` mean the agent direct model or the global
   default is in effect.

## Output Delivery

An inbound turn returns to its attached source chat or thread. The default
output attachment is used only for a turn with no inbound source. An
unattached inbound source MUST fail closed instead of falling back elsewhere.
Operator / HTTP `sessions.send` without `--channel`/`--to` MUST NOT emit to
leftover `lastChannel` or the default attachment; read the assistant row
from `sessions.read`.
