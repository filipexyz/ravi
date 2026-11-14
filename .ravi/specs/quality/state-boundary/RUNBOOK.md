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

If `PM2_HOME/pm2.pid` is absent, the guard verifies the actual parent with
`ps -ww -p <ppid> -o args=` and requires the default PM2 God Daemon title for
the same canonical PM2 home before querying the live registry. Do not use
`pids/ravi-0.pid` as the manager PID: it identifies the application. A custom
manager title with no default PID file remains unverifiable and fails closed.
Inspect PID/PPID and paths only; never print the full registry or environment.

The inert-stdin launcher does not write boot identity. Runtime code writes
`runtime-processes/ravi.json` or `ravi-channels.json` later. Absence of a receipt
does not explain a state-boundary refusal by itself: check supervisor identity
and the registry query separately. A version banner is tolerated; invalid JSON
or a failed query still refuses access.

The daemon role owns schema initialization; this does not establish exclusivity between daemon processes. Start it first; it initializes the router, cloud-chat bindings/approvals, outbound publication outbox, Slack automatic-output circuit, contacts, chat, credentials, console scope, insights, knowledge, Devin, human-bridge and PR publication stores before serving. Each store or lazy component records the exact package version after successful initialization. Then start channels from that same installed release.

For upgrades, stop the old channel runner before the daemon applies a new release's migrations, and start the new runner after daemon initialization. An already-running consumer is not a schema-migration coordinator.

Overlapping daemon startups remain a known limitation: supervised restart can
temporarily admit two owners, and concurrent failed migration can leave stale
readiness evidence. Do not treat a component marker as proof of exclusive
migration ownership. This PR does not change restart policy or serialize those
owners; the separate migration-coordination work must preserve legacy foreign-key
and nested-transaction semantics.

If channels starts first, it fails before connecting to NATS, without creating a database or migrating anything. The error names `STATE_SCHEMA_NOT_READY` and tells the operator to initialize the daemon first. Fix the boot order/version and start channels again; no configuration variable or allow flag is involved.

## Rollback

There is no configure-before-install environment step. The earlier proposed environment opt-in was discarded and was never applied by this work.

If a rollout unexpectedly refuses a legitimate runtime, restore the exact previous known-good installed package and its existing PM2 launchers, then verify daemon/channels readiness. Inspect process registration and the package path before retrying. Do not use a worktree on real state to recover. A refusal before SQLite opens requires no database rollback; any separate data migration needs its own recovery plan. Do not dump secrets while checking PM2.

No package installation, environment mutation, daemon restart or live-state repair is part of this PR's development work.

## Publication

Run focused tests and the spec/coverage gate with isolated state, then commit on
a work branch with pre-commit enabled. From the publishing Ravi session, preview
and execute the canonical publisher through an authenticated context on the
installed daemon gateway. A bare operator terminal is unsupported, and
`--reply-session` alone does not provide authentication:

```bash
ravi pr publish --repo filipexyz/ravi --base dev --title "Fix description" --body-file /tmp/pr-body.md
ravi pr publish --repo filipexyz/ravi --base dev --title "Fix description" --body-file /tmp/pr-body.md --execute
```

The command preserves the exact local commit and tree and reconciles the ready
PR and its CI follow. It does not run tests or merge. On a partial result, repeat
the same expected SHA after inspecting the reported phase. Use the complete
publication/recovery contract in `cli/pr`; do not revive the earlier snapshot
publisher or disable hooks. Full checks run in PR CI before merge.
