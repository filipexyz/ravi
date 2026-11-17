# Daemon Restart / CHECKS

## Checks

- `bun test src/cli/commands/daemon.test.ts` MUST pass.
- `bun test src/runtime/restart-reason.test.ts` MUST pass.

## Regression Scenarios

- State dir: with `RAVI_STATE_DIR` set, `restart-reason.txt` MUST exist only there after a daemon stop, a `ravi daemon restart` and the detached restart worker; nothing MUST be written under `$HOME/.ravi`.
- Relative state dir: with a relative `RAVI_STATE_DIR` and a caller in a different cwd than the daemon, the caller's `restart-reason.txt`, the worker and the environment `pm2 start` receives MUST all name the directory the daemon resolves (target cwd + value); the successor MUST NOT open an empty state directory.
- First boot: an empty state dir (no `restart-reason.txt`, no main session) MUST emit no restart event and MUST create no session; the log line `First boot: no restart reason` MUST appear.
- Plain restart: with no `restart-reason.txt` and an existing main session, the synthesized `supervised_restart` notice MUST still be delivered.

Per-session resume, caller preservation and crash recovery are checked in their own capability specs.
