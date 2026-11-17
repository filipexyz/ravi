# Daemon Restart / RUNBOOK

## Debug Flow

1. Resolve the state dir (`RAVI_STATE_DIR`, `~/.ravi` by default) and look for `restart-reason.txt` there.
2. If the file is missing after a stop, check whether the stopping process had a different `RAVI_STATE_DIR` than the one you are reading.
3. Read the daemon log for `Delivering daemon restart events` (a notice was published) or `First boot: no restart reason` (nothing to announce).
4. If a fresh install announces a restart, confirm no main session existed and that the daemon is on a release with the first-boot rule.

## Useful Signals

- `restartReason`, `restartEpoch` and `callerSessionName` in the delivery log line
- The state dir the daemon and the detached restart worker resolved
