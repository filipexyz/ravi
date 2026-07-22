# Plugin Location Checks

- [ ] Internal plugin paths MUST match `~/.cache/ravi/plugins/.snapshots/<digest>/<plugin-name>/`.
- [ ] A snapshot MUST NOT be accepted when `.complete` is missing or does not match its digest.
- [ ] Snapshot publication MUST use a private staging directory followed by an atomic rename.
- [ ] Discovery MUST preserve the plugin basename, such as `ravi-system`, below the digest directory.
- [ ] Runtime discovery MUST NOT overwrite or remove a published snapshot.
- [ ] Automatic cleanup MUST prove a snapshot is unused before deleting it.
