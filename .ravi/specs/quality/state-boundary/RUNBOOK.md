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

Residue that blocks: a status outside the rule of its table, an unreadable table, an unreachable broker, prompts left in `SESSION_PROMPTS` (memory storage, 60 s, not durable), mail/calendar rows `leased`/`sending` (no legacy owner resumes them), and non-terminal rows of `channel_outbound_receipts`, `channel_backend_runtime_state` and `cron_runs` (their resumption was not verified; kept blocking). Pending and in-flight work with a named owner (prompt queue, turn attempts, ingress receipts, Slack inbound envelopes, recovery, outboxes, sync inbox, decision deliveries, jobs, broker consumers) is recorded with its counts and carried by the successor, which re-reads the SQLite residue itself before installing the fence.

Work tables whose resumption in the successor was not verified (calls, workflow and automation runs, Devin sessions, cloud thread runs, credential attempts, grant applications, handoffs, library requests, reminders, Slack thread lifecycle, turn health and attention notices, adapters, reaction actions, unexpired publish and inbox leases) are searched in every runtime database. Their terminal and at-rest values come from the tag's own types; a value at rest carries its reason; a value listed as blocking is labelled `resumption not verified`, and a value outside the tag's vocabulary also blocks, labelled `owner not verified`.

The complete table set of the tag is `src/threads/fence-adoption-inventory.ts`, derived from every `CREATE TABLE` of `v3.261113.2` by `bun scripts/fence-adoption-inventory.ts`. `fence-adoption-inventory.test.ts` (in `test:runtime-identity`) re-derives it from the tag and compares, reads each declared vocabulary from the tag, and fails when a table with a status, state, claim, lease or work-marker column has neither a rule nor an exclusion with a reason.

The runtime databases are those of `runtimeStateDatabasePaths` for the state directory; the credentials database follows `RAVI_CREDENTIALS_DB_PATH` from the environment of the process that runs the command, so run it with the same environment as the daemon.

**Before the window: read the residue while `3.261113.2` runs.** The step 2 preview also returns `residuePreview`: the same SQLite rules, read only, before any stop (the broker is not read; its residue is what the stop drains). Work in flight there is normal and drains with the stop. The evidence that counts is still the one read after both stops. What the preview is for is residue that no process settles after the stop, because the window then blocks with production stopped, and neither `retry` (nothing settles it while production is stopped) nor `abandon` (`3.261113.2` does not settle it either) is an exit for it:

- `thread_handoffs` `queued`: `sessions send --thread` inserts it before the send and settles it only after waiting for the reply (tag `src/cli/commands/sessions.ts` l.4906-5046, `src/threads/service.ts` l.611-650); task dispatch settles `delivered` only (`src/tasks/dispatch-admission.ts` l.45-97). A sender that died leaves it `queued` for good.
- `permission_grant_applications` `applying` (`src/permissions/apply-grant.ts` l.383-398, l.504-541), `task_automation_runs` `claimed` (`src/tasks/automations.ts` l.474-581), `runtime_credential_attempts` `reserved`/`started` (`src/runtime/credential-store.ts` l.552-582): same class, a process that died between begin and end.
- Calls (`call_requests` `running`, `call_runs` `queued` to `in_progress`, `call_tool_runs` `pending`/`running`), workflow runs `ready`/`running`, Devin sessions and cloud thread runs end with their call, run or tasks: wait for them, then preview again.

Exit, in this order: wait and preview again; for the dead-process class, the settle step below; otherwise postpone the window.

**Settle step: writes production rows by hand, so it runs only with the operator's explicit authorization**, under `3.261113.2`, before the window, only on rows the preview listed, after confirming that the work of each row is not running. List them first with `sqlite3 -readonly "${RAVI_STATE_DIR:-$HOME/.ravi}/ravi.db" "SELECT rowid, * FROM thread_handoffs WHERE status = 'queued'"` (same for the other tables, in the database the preview label names). Then, in the same database:

```sql
-- A handoff whose sender died: the same write as the tag's failure path (threads/service.ts).
UPDATE thread_handoffs
   SET status = 'failed',
       failed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       failure_reason = 'sender died before the outcome; settled before thread-fence adoption',
       updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE status = 'queued' AND rowid IN (<rowids>);
-- An automation claim that never spawned, and a credential attempt of a dead process.
UPDATE task_automation_runs SET status = 'failed' WHERE status = 'claimed' AND rowid IN (<rowids>);
UPDATE runtime_credential_attempts
   SET status = 'abandoned', completed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE status IN ('reserved', 'started') AND rowid IN (<rowids>);
```

A grant `applying` is settled only if its effect is in place (`ravi permissions list` shows the grant for that subject and scope): `UPDATE permission_grant_applications SET status = 'done', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE status = 'applying' AND idempotency_key = '<key>'`. `result_json` stays empty, so a later click with the same key applies again instead of replaying. If the effect is not in place, leave the row and postpone: applying a grant again is a decision of its own. Preview again; the window starts only with no dead-process residue listed.

**60-minute window for pending messages.** The legacy daemon's own stop (any signal) writes a restart epoch to `restart-reason.txt` and snapshots every non-idle session with its pending messages in `daemon_restart_session_snapshots`. The next daemon to boot (the successor, or `3.261113.2` after `abandon`) resumes that epoch only if it starts within 60 minutes of the stop (`RESTART_RESUME_WINDOW_MS`). The evidence counts the sessions with pending messages of the latest epoch only (older epochs are history). Adoption and recovery never touch `restart-reason.txt`. If a block keeps production down close to 60 minutes, decide before it expires: fix and `retry`, or `abandon` and start `3.261113.2` at once. If the window expires, those messages are not resumed by anyone. To send them again, read them from `ravi.db` (the latest epoch is the stop's own; check that its `stopped_at` is the time of this stop):

```sh
sqlite3 -readonly -json "${RAVI_STATE_DIR:-$HOME/.ravi}/ravi.db" "
  SELECT s.session_name, s.stopped_at, json_extract(m.value, '$.message.content') AS text
    FROM daemon_restart_session_snapshots s, json_each(s.pending_messages_json) m
   WHERE s.restart_epoch = (SELECT restart_epoch FROM daemon_restart_session_snapshots ORDER BY stopped_at DESC LIMIT 1)
   ORDER BY s.session_name, json_extract(m.value, '$.queuedAt')"
```

Each entry is a queued user message of the tag (`createQueuedRuntimeUserMessage`, `src/runtime/delivery-queue.ts` l.38-52): `text` is the prompt as it was queued, header included. Send each one again, in order, with `ravi sessions send <session_name> "<text>"`.

**Check PM2's kill timeout before the window.** `pm2 stop` sends SIGINT and then SIGKILL after the registration's `kill_timeout`; the tag's launchers set none, so PM2's default (1600 ms) applies, while the legacy shutdown gives itself 15 s (`src/daemon.ts` l.244-247). A SIGKILL before the snapshot is written loses the pending messages of that stop. See the value with `pm2 jlist` (field `pm2_env.kill_timeout`; absent means the default). Raising it changes the PM2 registration, so it is the operator's decision; without it, after the stop compare the latest epoch's `stopped_at` with the time of the stop: an older epoch means this stop wrote no snapshot (nothing was pending, or the shutdown was cut).

Rows mirrored from remote systems (Devin sessions in `new`, `creating`, `claimed`, `running` or `resuming`; cloud thread runs in `starting` or `running`) only change when the legacy release syncs them; a row that is never synced again blocks. Let `3.261113.2` settle them before the window; the step 2 preview lists which exist.

The inventory test reads `v3.261113.2` from git. A clone without the tag fails with `LEGACY_TAG_MISSING` and the command to fetch it: `git fetch --no-tags origin refs/tags/v3.261113.2:refs/tags/v3.261113.2` (the gate job checks out with `fetch-depth: 0`).

If a command reports "another adoption coordinator or recovery is running" and none should be: the holder is the process with `runtime-maintenance/coordinator.lock` open (`lsof` on that file). Stop that process; the kernel releases the lock when it exits. Never delete the lock file.

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
| No mode applies, successor alive or its exit unknown (including the command's 180 s timeout) | both runtimes, or channels | Wait: the successor finishes or blocks by itself, and the preview then lists a mode. If it hangs, `ravi daemon logs`; stop it through PM2 (`pm2 stop ravi`) and preview again: with its exit proven, `retry` or `abandon` apply (or `release`, if it installed the fence). |
| No mode applies, records of different maintenances | both runtimes | Not produced by these commands: stop and inspect `runtime-maintenance/` by hand with the maintainers; never delete or edit a record to make a mode appear. |
| The preview fails because `adoption.json` or `active.json` is corrupt (`*_CORRUPT`) | both runtimes | Same: keep the files as evidence, stop, and escalate; no command recovers from a record it cannot read. |

After `release`: the fence exists; start whatever is stopped with `ravi daemon start` and `ravi channels start` (the adopt command starts channels only after the interlock is really gone).

After `abandon` (never a fence): the installed bundle refuses to boot on this database, so reinstall `3.261113.2` before starting. The legacy release does not know the interlock; `abandon` already removed it, so nothing is left orphaned. To try again, wait for the legacy runtime to settle the residue that blocked, then reinstall the target and start from step 1.

Do not remove the interlock, the lease or the successor claim by hand, downgrade schema markers, clear queues/claims, reset context or expire a lease to force progress. Canonical health/attention JOINs and legacy context provenance (resume and local recovery) remain gates before any cross-audience projection.

A failed shutdown drain must retain its failure while attempting the other component stops and exit nonzero. It must not tear down shared NATS/SQLite handles as though all accepted component work had settled. Neither a zero exit nor a scoped drain receipt replaces the external accepted-work verifier.

Inspect the shutdown result's named `failures`, `drain.phase` and exit code together. Nested stop/close failures preserve their original causes in an aggregate. `blocked` remains an unsuccessful shutdown even if another sibling or a later cleanup retry succeeds. Do not clear that result, reset queues or restart the live daemon to test it; use isolated failure-injection tests for Knowledge, SQLite, subscriptions and media.


For isolated CLI/fixture creation, `withNewIsolatedThreadState(parent, callback)` creates a private directory and exclusive database file. Seed an old schema and initialize it within the synchronous ownership callback; do not launch a runtime or share this state until initialization finishes. This is proof by creation/ownership, not a rule that temporary paths are safe.

An already-existing database requires `withExitedThreadBootstrapAuthorization` from reviewed coordinator code. The coordinator holds external launcher/admission exclusion throughout the synchronous callback and supplies complete inventory plus accepted-work evidence for both exact predecessors. The SQL boundary rechecks physical exits and evidence under the schema lock. The API neither stops/starts services nor releases an interlock; real-state process-role and entrypoint guards remain in force, so this does not complete the production rollout workflow.

Inspect `<database>.thread-bootstrap.jsonl` for `thread-bootstrap-authorized`, its reason and evidence references. This log records authorization before SQL, not successful installation or migration. Missing/failed audit persistence refuses installation. Do not manufacture an audit record or use it as reusable authorization.
