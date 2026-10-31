---
id: quality/state-boundary
title: "Real State and Process Roles"
kind: capability
domain: quality
capability: state-boundary
status: active
normative: true
---

# Operating the state boundary

## CLI, tests and worktrees

Select a disposable directory explicitly on the command:

```bash
RAVI_STATE_DIR="$(mktemp -d)" bun test src/router/state-boundary.test.ts
```

For real state use the installed daemon gateway. Selecting `~/.ravi` explicitly, setting process-name variables or adding `daemon run` to argv does not turn a CLI/worktree into the runtime. Do not change HOME or copy real databases into a test path to evade the boundary.

A refusal after cleanup means the caller lost its isolated state. Fix its state selection/cleanup; do not disable the guard. `getDb()` is not a readonly operation because it initializes schema.

## Runtime identity

The installed daemon owns real state by process identity, with no new launcher flag. Its code must be outside source/worktree roots, its actual parent must be the PM2 manager and its current PID/executable/arguments must match the registered runtime. Environment labels alone are ignored. Inspect only the relevant process identifiers/paths; never dump the secret-bearing PM2 environment.

## Boot and upgrades

The daemon is the only schema owner. Start it first; it initializes the router, contacts, chat, credentials, console scope, insights, knowledge and Devin stores before serving. Each store records the exact package version after successful initialization. Then start channels from that same installed release.

For upgrades, stop the old channel runner before the daemon applies a new release's migrations, and start the new runner after daemon initialization. An already-running consumer is not a schema-migration coordinator.

If channels starts first, it fails before connecting to NATS, without creating a database or migrating anything. The error names `STATE_SCHEMA_NOT_READY` and tells the operator to initialize the daemon first. Fix the boot order/version and start channels again; no configuration variable or allow flag is involved.

## Rollback

There is no configure-before-install environment step. The earlier proposed environment opt-in was discarded and was never applied by this work.

If a rollout unexpectedly refuses a legitimate runtime, restore the exact previous known-good installed package and its existing PM2 launchers, then verify daemon/channels readiness. Inspect process registration and the package path before retrying. Do not use a worktree on real state to recover. A refusal before SQLite opens requires no database rollback; any separate data migration needs its own recovery plan. Do not dump secrets while checking PM2.

No package installation, environment mutation, daemon restart or live-state repair is part of this PR's development work.

## Publication

Commit on a work branch from `origin/dev`, keeping pre-commit enabled, then preview:

```bash
bun scripts/publish-branch.ts --branch fix/example --test src/router/state-boundary.test.ts
```

Repeat `--test` for relevant exact files. Execute the same command with `--execute`, then open a PR against dev with every template section. Full checks run in PR CI; no merge without the operator's instruction.

For the same PR's next revision, fetch its remote branch and merge that snapshot locally (`git merge --no-edit origin/<work-branch>`), then use `--update` for preview and execution. The tool appends to that exact parent with `force: false`; a moved head requires fetching/integrating again. No hooks are changed. API errors can leave unreachable Git objects, not an unchecked ref after a hash mismatch.
