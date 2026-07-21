# Plugin Runtime Runbook

## Diagnose internal plugin discovery

1. Start a fresh Ravi process and inspect the `Internal plugins loaded` log entry.
2. Confirm its path is under `~/.cache/ravi/plugins/.snapshots/<digest>/`.
3. Confirm each returned plugin directory contains `.claude-plugin/plugin.json`.
4. Run a second Ravi CLI from another installed version while the first process is active.
5. Confirm both snapshot paths remain readable and neither process reports `ENOENT` while traversing plugin files.

Published snapshots are immutable. Do not repair one in place or delete it while a process may still reference it. A broken snapshot should be diagnosed from the embedded artifact and replaced by a new content-addressed snapshot.

## Rollback

Revert the runtime change and restart Ravi. Existing snapshot directories are cache data and may remain on disk; they are ignored by runtimes that use the former flat layout.
