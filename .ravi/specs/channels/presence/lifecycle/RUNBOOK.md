# Presence Lifecycle / RUNBOOK

## Debug Flow

1. Check runtime turn state for the session.
2. Check whether a terminal event was observed.
3. Check whether presence was stopped on silent/final output.
4. Check whether a delayed renewal fired after terminal state.
5. Verify the target chat/session of each presence event.

## Commands

```bash
ravi sessions trace <session> --since 90m --explain
ravi sessions trace <session> --since 90m --only presence --raw
ravi events replay --stream RAVI_EVENTS,SYSTEM --subject "ravi.presence.>" --since 90m --json
```

Use `--only presence` to inspect `presence.typing` rows. A healthy interactive turn should show an `active` transition near semantic runtime start/renewal and an `inactive` transition after `@@SILENT@@`, `status=idle`, `turn.complete`, `turn.completed`, `turn.failed`, or `session.timeout`. Raw provider passthrough events should not be the reason presence starts or renews. Background cron/automation turns that carry `suppressPresence=true` on the runtime source should not emit `typing=true`; verify their final delivery separately with session delivery trace.

## Useful Signals

- Session name
- Channel/account/chat target
- Runtime event type
- Terminal state
- Renewal reason
- Presence status: `active`, `inactive`, `skipped`, or `failed`
- Presence reason: `start`, `renew`, `heartbeat`, `stop`, `terminal-stop`, `terminal-clear-active-target`, or fallback reason
