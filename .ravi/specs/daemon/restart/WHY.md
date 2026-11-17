# Daemon Restart / WHY

## Rationale

A restart is only trustworthy if the daemon knows why it stopped and tells the right session once. The reason is runtime state, so it belongs to the state directory the daemon runs in, not to the user's home: two installs with different state dirs must not read each other's reason.

A plain `pm2 restart` writes no reason, so the boot synthesizes one to keep the operator informed. On a first boot nothing was restarted and no session exists to tell, so inventing a restart there only creates a session and spends a turn.

## Tradeoffs

- Resolving the file from the state dir changes nothing for installs that leave `RAVI_STATE_DIR` unset.
- With a custom `RAVI_STATE_DIR`, the first update from a release that wrote the file under `~/.ravi` does not see it; that one stop is not resumed. Production does not set the variable, and a fallback read would reintroduce cross-install mixing.
