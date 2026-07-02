---
id: apps
title: "Ravi Apps Runbook"
kind: domain
domain: apps
status: active
normative: false
---

# Ravi Apps Runbook

## Scaffold A New App

```bash
ravi apps scaffold <app-id> --dry-run --json   # preview
ravi apps scaffold <app-id> --json             # create
```

## Inspect An App

```bash
ravi apps list --json
ravi apps show <app-id> --json
ravi apps check <app-id> --json
```

## Delete A Scaffolded App

```bash
ravi apps delete <app-id> --dry-run --json     # preview
ravi apps delete <app-id> --json               # execute
```

See `apps/lifecycle` spec for delete contract details.

## Handle Scaffold Collision

If `ravi apps scaffold <id>` returns `already_exists`:

```bash
ravi apps show <id> --json        # inspect the existing app
ravi apps scaffold <id> --force   # overwrite if intended
```

## Handle Absent App

If `ravi apps show <id>` or `ravi apps delete <id>` returns `not_found`:

```bash
ravi apps list --json             # verify available apps
ravi apps scaffold <id> --json    # create if needed
```

## Debug App Permissions

```bash
ravi agents permissions <agent> --json
ravi permissions check agent:<agent> use app:<app-id>
ravi permissions check agent:<agent> execute app:<app-id>
```

## Validate App Specs

```bash
ravi specs sync --json
ravi specs get apps/<app-id> --mode full --json
```
