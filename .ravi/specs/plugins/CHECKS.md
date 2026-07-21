# Plugin Checks

- [ ] Internal plugin materialization MUST publish a completion marker only after every embedded file is written.
- [ ] Concurrent processes with the same artifact MUST return the same complete snapshot path.
- [ ] Different embedded artifacts MUST return different snapshot paths.
- [ ] Publishing a newer artifact MUST NOT remove or mutate an older published snapshot.
- [ ] User plugins under `~/ravi/plugins/` MUST remain outside internal snapshot lifecycle operations.
- [ ] Discovery MUST return internal plugins before user plugins.
