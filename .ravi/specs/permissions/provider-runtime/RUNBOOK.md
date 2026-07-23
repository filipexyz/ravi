# Permission Provider Runtime / RUNBOOK

## Recover A Mixed-Version Channel Runner

Use this sequence when channels fail after an update because a stale channel
runner still expects storage retired by the new bundle:

```bash
ravi channels stop
ravi daemon restart -m "recover mixed-version runtime"
ravi channels start
```

Do not recreate retired permission tables. Confirm that both managed processes
that were online before the update return online and that a new inbound channel
turn completes without a schema error.

## Validate Update Coordination

```bash
bun test src/cli/commands/update.test.ts src/router/router.test.ts
bun run typecheck
bun run build
```

The updater must preserve the pre-update running set, stop channel intake before
the daemon transition, and report any managed process that does not return
online.
