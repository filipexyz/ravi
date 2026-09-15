# Ravi App Lifecycle / RUNBOOK

## Delete A Scaffolded App

1. Preview:

```bash
ravi apps delete <app-id> --dry-run --json
```

2. Delete:

```bash
ravi apps delete <app-id> --json
```

3. Verify removal:

```bash
ravi apps list --json
ravi apps check --json
```

## Handle Scaffold Collision

1. If `ravi apps scaffold <id>` returns `already_exists`:

```bash
ravi apps show <id> --json        # inspect the existing app
ravi apps scaffold <id> --force   # refresh contracts; preserve existing cli.ts
```

## Handle Absent App

1. If `ravi apps show <id>` or `ravi apps delete <id>` returns `not_found`:

```bash
ravi apps list --json             # verify available apps
ravi apps scaffold <id> --json    # create if needed
```

## Debug Delete Failure

1. If delete reports no files to remove, the app may have been created outside
   the scaffold or already deleted.
2. If delete refuses to run, check that the app id is valid and the app was
   created by `ravi apps scaffold`.
3. Delete never removes implementation files, runtime storage, or credentials.
   Those must be managed separately.
