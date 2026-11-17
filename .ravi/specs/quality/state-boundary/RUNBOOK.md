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

## The operator's terminal

The installed `ravi` runs its commands in the terminal, on real state, with no gateway in between. It never creates or migrates a store there. When a command answers `STATE_SCHEMA_NOT_READY`, the daemon of this release has not prepared a store yet (first start, or an update whose restart has not happened):

```bash
ravi daemon restart -m "prepare state"
```

`ravi daemon start|stop|restart|status|logs`, the same `ravi channels` commands and `ravi update` work with no database, so they are always available to recover.

## Tests, worktrees and source checkouts

Select a disposable directory explicitly on the command:

```bash
RAVI_STATE_DIR="$(mktemp -d)" bun test src/router/state-boundary.test.ts
```

Code run from a checkout, a worktree or a build never reaches real state. Selecting `~/.ravi` explicitly, setting process-name variables or adding `daemon run` to argv does not turn a worktree into the runtime or into the operator's CLI. Do not change HOME or copy real databases into a test path to evade the boundary. An agent's turn carries a runtime context and goes through the installed daemon gateway.

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
a work branch with pre-commit enabled. Preview and execute the canonical
publisher from the publishing Ravi session, or from the operator's terminal with
the installed CLI, naming the session whose chat receives the CI follow:

```bash
ravi pr publish --repo filipexyz/ravi --base dev --title "Fix description" --body-file /tmp/pr-body.md
ravi pr publish --repo filipexyz/ravi --base dev --title "Fix description" --body-file /tmp/pr-body.md --execute
# from a terminal
ravi pr publish --repo filipexyz/ravi --base dev --title "Fix description" --body-file /tmp/pr-body.md --reply-session <session> --execute
```

The command preserves the exact local commit and tree and reconciles the ready
PR and its CI follow. It does not run tests or merge. On a partial result, repeat
the same expected SHA after inspecting the reported phase. Use the complete
publication/recovery contract in `cli/pr`; do not revive the earlier snapshot
publisher or disable hooks. Full checks run in PR CI before merge.

## Thread fence adoption (one time, legacy database)

A release with the thread fence refuses to start on a database that has no fence. Independent `daemon restart` / `channels restart` never fix this, and there is deliberately no env flag or file-hash waiver. The fence is installed once, by `ravi maintenance thread-fence-adopt`. Once the fence exists, ordinary restarts and updates apply and none of this runs again.

Run it from the operator's terminal (offline recovery path), never from an agent session or through the gateway: both runtimes are down while it runs.

1. Install the target release without restarting. The `ravi` and `ravi-channels` PM2 registrations must start the installed bundle; the running processes are still the legacy release. From here until the adoption, a legacy process that dies is relaunched by PM2 on the new bundle, which refuses (no fence) and the plan then refuses too: reinstall `3.261113.2`, start it, and begin again.
2. `ravi maintenance thread-fence-adopt` prints the read-only plan and exits 3. It refuses when the database already has the fence, an adoption record exists, a registration is missing or duplicated, a process is not online under PM2, a boot receipt does not match the running pid/start time, a predecessor already runs the target bundle, or another launcher starts the Ravi bundle.
3. `ravi maintenance thread-fence-adopt --execute`:
   - holds the coordinator lease (`runtime-maintenance/coordinator.lock`, an OS lock released when the process dies), takes the interlock, and writes `adoption.json` (`preparing`) before the first stop; on failure it records `preparation-blocked` and keeps the interlock;
   - stops `ravi-channels`, then `ravi`, with `pm2 stop` (registrations stay, so PM2 cannot relaunch them) and accepts only ESRCH as exit;
   - re-reads the registry: no relaunch, no replacement, bundle unchanged;
   - reads the durable residue read-only: router database (`ravi.db`) by status, and JetStream (`CHANNEL_OUTBOUND`, omni `MESSAGE`/`INSTANCE`/`REACTION` consumers, `SESSION_PROMPTS`);
   - writes evidence under `runtime-maintenance/evidence/<id>/` and the authorization in `runtime-maintenance/adoption.json`;
   - starts `ravi` through PM2. The entrypoint admits only the authorized bundle, once (`runtime-maintenance/successor`), installs the fence inside `withExitedThreadBootstrapAuthorization`, records `adopted` and releases the interlock last. Channels start after that, through their ordinary guarded entry.

Residue that blocks: a status outside the rule of its table, an unreadable table, an unreachable broker, prompts left in `SESSION_PROMPTS` (memory storage, 60 s, not durable), mail/calendar rows `leased`/`sending` (no legacy owner resumes them), and non-terminal rows of `channel_outbound_receipts`, `channel_backend_runtime_state` and `cron_runs` (owner not verified). Pending and in-flight work with a named owner (prompt queue, turn attempts, ingress receipts, recovery, outboxes, sync inbox, decision deliveries, jobs, broker consumers) is recorded with its counts and carried by the successor, which re-reads the SQLite residue itself before installing the fence.

### When something stops

`ravi maintenance thread-fence-recover --mode release` (without `--execute`) prints the whole state: interlock, maintenance record, adoption record, successor claim, fence, predecessor and successor exits, the modes that apply now and the diagnosis. Act only on a mode it lists.

| Stopped at | What is down | Exit |
|---|---|---|
| Plan refused | nothing | fix what it names; nothing was written |
| A stop failed, an exit unproven, a relaunch, the bundle changed, residue unknown or broker unreachable (`preparation-blocked`) | what was already stopped; the interlock refuses new-bundle starts | `retry` resumes (re-checks everything, does not stop again what is gone) once the cause is fixed; `abandon` releases the interlock |
| Coordinator killed mid-preparation (`preparing`, lease free) | same | `retry` or `abandon` |
| Interlock with a maintenance record and no adoption record, or with no record at all | same | `abandon` |
| Successor failed before the fence (`blocked`) | both runtimes | `retry` authorizes one new successor and starts it; `abandon` |
| Fence installed, interlock or records left behind (crash in the release) | channels | `release` |

After `release`: the fence exists; start whatever is stopped with `ravi daemon start` and `ravi channels start` (the adopt command starts channels only after the interlock is really gone).

After `abandon` (never a fence): the installed bundle refuses to boot on this database, so reinstall `3.261113.2` before starting. The legacy release does not know the interlock; `abandon` already removed it, so nothing is left orphaned. To try again, wait for the legacy runtime to settle the residue that blocked, then reinstall the target and start from step 1.

Do not remove the interlock, the lease or the successor claim by hand, downgrade schema markers, clear queues/claims, reset context or expire a lease to force progress. Canonical health/attention JOINs and legacy context provenance (resume and local recovery) remain gates before any cross-audience projection.

A failed shutdown drain must retain its failure while attempting the other component stops and exit nonzero. It must not tear down shared NATS/SQLite handles as though all accepted component work had settled. Neither a zero exit nor a scoped drain receipt replaces the external accepted-work verifier.

Inspect the shutdown result's named `failures`, `drain.phase` and exit code together. Nested stop/close failures preserve their original causes in an aggregate. `blocked` remains an unsuccessful shutdown even if another sibling or a later cleanup retry succeeds. Do not clear that result, reset queues or restart the live daemon to test it; use isolated failure-injection tests for Knowledge, SQLite, subscriptions and media.


For isolated CLI/fixture creation, `withNewIsolatedThreadState(parent, callback)` creates a private directory and exclusive database file. Seed an old schema and initialize it within the synchronous ownership callback; do not launch a runtime or share this state until initialization finishes. This is proof by creation/ownership, not a rule that temporary paths are safe.

An already-existing database requires `withExitedThreadBootstrapAuthorization` from reviewed coordinator code. The coordinator holds external launcher/admission exclusion throughout the synchronous callback and supplies complete inventory plus accepted-work evidence for both exact predecessors. The SQL boundary rechecks physical exits and evidence under the schema lock. The API neither stops/starts services nor releases an interlock; real-state process-role and entrypoint guards remain in force, so this does not complete the production rollout workflow.

Inspect `<database>.thread-bootstrap.jsonl` for `thread-bootstrap-authorized`, its reason and evidence references. This log records authorization before SQL, not successful installation or migration. Missing/failed audit persistence refuses installation. Do not manufacture an audit record or use it as reusable authorization.
