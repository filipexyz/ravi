# Plugin Location Runbook

## Inspect a snapshot

1. Read the `Internal plugins loaded` log entry to obtain the resolved snapshot directory.
2. Verify the directory is `~/.cache/ravi/plugins/.snapshots/<digest>/`.
3. Verify `.complete` contains the same digest used by the directory name.
4. Verify each plugin child has `.claude-plugin/plugin.json` and its expected files.

Directories named `.staging-*` are unpublished work areas. A crashed process may leave one behind; it is safe to remove only when no live process is writing it. Published digest directories must not be pruned based only on age or count because a long-lived process may still hold their paths.

## Version skew check

Run discovery from both installed Ravi bundles. Different embedded contents should resolve to different digest directories, and both trees should stay readable for the duration of the processes.
