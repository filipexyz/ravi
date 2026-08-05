# Ravi App Scaffold / RUNBOOK

## Create A New App

1. Preview:

```bash
ravi apps scaffold <app-id> --dry-run --json
```

2. Generate:

```bash
ravi apps scaffold <app-id> --name "Name" --description "What this app does" --json
```

3. Validate:

```bash
ravi apps check <app-id> --json
ravi apps show <app-id> --json
ravi apps guide <app-id> --json
```

4. Run `ravi <app-id> list --json` to prove the generated CLI route, then
   implement the actual domain operations declared by the manifest.

5. Review `context.allow` and add only capabilities the CLI needs to call
   public Ravi commands.

6. Re-run manifest, router, and child-context checks.

Use `--command "<app-cli>"` only when the implementation CLI already exists.
In that mode scaffold does not generate `cli.ts`.

## Debug Scaffold Failure

1. If the target exists, choose a new id or re-run with `--force`.
2. If app id validation fails, use lowercase slug segments.
3. If manifest check fails after scaffold, inspect UI operation references and
   event topics first.
4. If the skill is not discoverable, run `ravi skills list --json` and inspect
   the internal plugin catalog.
