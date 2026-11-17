# Daemon Restart / CHECKS

## Checks

- `bun test src/cli/commands/daemon.test.ts`
- `bun test src/runtime/restart-reason.test.ts`

## Regression Scenarios

- State dir: with `RAVI_STATE_DIR` set, `restart-reason.txt` exists only there after a daemon stop, a `ravi daemon restart` and the detached restart worker; nothing is written under `$HOME/.ravi`.
- First boot: an empty state dir (no `restart-reason.txt`, no main session) emits no restart event and creates no session; the log says `First boot: no restart reason`.
- Plain restart: no `restart-reason.txt` but an existing main session still gets the synthesized `supervised_restart` notice.

Per-session resume, caller preservation and crash recovery are checked in their own capability specs.
