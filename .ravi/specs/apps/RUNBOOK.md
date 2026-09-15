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
ravi apps scaffold <app-id> --dry-run --json
ravi apps scaffold <app-id> --json
```

The default generates `bun cli.ts`. Pass `--command "<app-cli>"` when a real
implementation CLI already exists.

## Inspect An App

```bash
ravi apps list --json
ravi apps show <app-id> --json
ravi apps check <app-id> --json
```

## Run An App

```bash
ravi <app-id> <operation> [args...]
ravi <app-id> <operation> [args...] --json
```

Use `--json` only when the caller needs structured output. The app process still
uses the normal CLI contract.

Use `ravi apps run <app-id> <operation>` only for router diagnostics or a static
root-command collision.

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
ravi apps scaffold <id> --force   # refresh contracts; preserve existing cli.ts
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

Then inspect the app's child-context request:

```bash
ravi apps show <app-id> --json
ravi context list --json
ravi context info <context-id> --json
```

Confirm the launched CLI received a child `RAVI_CONTEXT_KEY`, not the parent
key, and that its capabilities do not exceed `manifest.context.allow`.

## Validate App Specs

```bash
ravi specs sync --json
ravi specs get apps/<app-id> --mode full --json
```
