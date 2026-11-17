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

What the residue read does with each table (the coordinator's read after both stops, and the successor's own read before it installs the fence):

- **Carried**: pending and in-flight work with a named owner in this release, counted in the evidence: prompt queue, turn attempts, ingress receipts, Slack inbound envelopes, recovery, outboxes, sync inbox, decision deliveries, jobs, broker consumers, adapters, library requests; Slack threads being created and turns in flight, which the gateway reconciliation resumes or recomputes at boot and every 30 s; Devin sessions, mirrors that no daemon process holds; cloud thread runs, whose events the Console keeps until this release's delivery runner applies them; workflow runs, recomputed from their tasks; credential attempts, records whose turn is carried by the turn attempts and the restart snapshots.
- **Restart snapshots**: the sessions the legacy stop left for the restart resume, read for the epoch named in `~/.ravi/restart-reason.txt`, with the successor's own eligibility. Carried until 60 minutes after the stop, less 10 minutes for the successor's boot; past that, or when the file names no epoch, they block (see the 60-minute window below).
- **Blocking, with a settle step** (label `resumption not verified`): values that no release resumes or recomputes. Each has its settle step below.
- **Unknown**: a value outside the tag's vocabulary (`owner not verified`), an unreadable table, an unreachable broker, prompts left in `SESSION_PROMPTS` (memory storage, 60 s, not durable).

Work tables are searched in every runtime database. Their terminal and at-rest values come from the tag's own types and writers; a value at rest carries its reason.

The complete table set of the tag is `src/threads/fence-adoption-inventory.ts`, derived from every `CREATE TABLE` of `v3.261113.2` by `bun scripts/fence-adoption-inventory.ts`. `fence-adoption-inventory.test.ts` (in `test:runtime-identity`) re-derives it from the tag and compares, reads each declared vocabulary from the tag, and fails when a table with a status, state, claim, lease or work-marker column has neither a rule nor an exclusion with a reason.

The runtime databases are those of `runtimeStateDatabasePaths` for the state directory; the credentials database follows `RAVI_CREDENTIALS_DB_PATH` from the environment of the process that runs the command, so run it with the same environment as the daemon.

**The exit for a blocking row is after the stop.** When the read after the stops lists blocking rows, the adoption is `preparation-blocked`: both runtimes are stopped, their exits proven, and the interlock refuses any new start. That is when the settle step runs, with the operator's explicit authorization: no writer is alive, so nothing races the write, and "is the work of this row still running?" is already answered. Then `ravi maintenance thread-fence-recover --mode retry --execute` repeats the read and, with nothing blocking, starts the successor. This is the exit for rows the stop itself creates (a call or an admission it cut) as much as for old ones. The step 2 preview (`residuePreview`, the same rules read only before any stop; not the broker, whose residue the stop drains, nor the restart snapshots, whose epoch only the stop creates) shows the old ones, so they can be settled the same way before the window, under `3.261113.2`, to keep production down for less time. Watch the clock while settling: past the window the restart snapshots block too.

**Settle step: writes production rows by hand. Every statement below is the operator's act (Luís), authorized for the listed rows; nothing in the code runs it.** List the rows first, read only, in the database the label names: `sqlite3 -readonly "${RAVI_STATE_DIR:-$HOME/.ravi}/ravi.db" "SELECT rowid, * FROM <table> WHERE <status column> IN (<values in the label>)"`. Then write only those rows, with the same columns the tag's own writer sets (`<now>` is `CAST(strftime('%s', 'now') AS INTEGER) * 1000`):

```sql
-- Operator's act (Luís). A handoff whose sender died: the tag's failure path (threads/service.ts l.660-667).
UPDATE thread_handoffs
   SET status = 'failed', failed_at = <now>, updated_at = <now>,
       failure_reason = 'sender died before the outcome; settled at thread-fence adoption'
 WHERE status = 'queued' AND rowid IN (<rowids>);
-- Operator's act (Luís). An automation claim that never spawned (tasks/automations-db.ts l.478-484).
UPDATE task_automation_runs
   SET status = 'failed', spawned_task_id = NULL, updated_at = <now>,
       message = 'claimed by a process that stopped; settled at thread-fence adoption'
 WHERE status = 'claimed' AND rowid IN (<rowids>);
-- Operator's act (Luís). An attention admission the stop cut: its outcome is unknown, which is what
-- the tag's own `uncertain` records (thread-attention-admission.ts l.148-155); it is never replayed.
UPDATE slack_thread_attention_notices SET admission_status = 'uncertain'
 WHERE admission_status = 'accepting' AND rowid IN (<rowids>);
-- Operator's act (Luís). A cron run whose session never reported (cron/run-db.ts l.54). The job's
-- next run waits for it, in both releases, so this also unblocks the job.
UPDATE cron_runs SET status = 'error', finished_at = <now>,
       error = 'its session never reported; settled at thread-fence adoption'
 WHERE status = 'pending' AND rowid IN (<rowids>);
-- Operator's act (Luís). The runtime state of a channel turn the stop cut: the tag's upsert sets
-- state and updated_at (router/router-db.ts l.7710); nothing lists or reconciles these rows.
UPDATE channel_backend_runtime_state SET state = 'interrupted', updated_at = <now>
 WHERE state IN ('accepted', 'running', 'waiting_approval') AND rowid IN (<rowids>);
-- Operator's act (Luís). Calls the stop caught (prox/calls/calls-db.ts l.831-834, l.872-899,
-- l.1660-1681). First confirm on the provider's side that the call ended; the transcript and result
-- it would have posted are lost.
UPDATE call_runs SET status = 'failed', ended_at = COALESCE(ended_at, <now>),
       failure_reason = 'the daemon stopped during the call (thread-fence adoption)'
 WHERE status IN ('queued', 'dialing', 'ringing', 'in_progress') AND rowid IN (<rowids>);
UPDATE call_requests SET status = 'failed', updated_at = <now>
 WHERE status = 'running' AND rowid IN (<rowids>);
UPDATE call_tool_runs SET status = 'failed', completed_at = <now>, duration_ms = <now> - started_at,
       error_message = 'the daemon stopped during the call (thread-fence adoption)'
 WHERE status IN ('pending', 'running') AND rowid IN (<rowids>);
```

Outbound receipts (operator's act, Luís), per state, in the database the label names. `sent` and `persisted`: the provider accepted the message; what is missing is the bookkeeping. Write what the tag's completion writes (`channels/outbound-receipts.ts` l.392-408): `UPDATE channel_outbound_receipts SET state = 'complete', completed_at = COALESCE(completed_at, <now>), last_error_phase = NULL, last_error_message = NULL, last_error_at = NULL, updated_at = <now> WHERE state IN ('sent', 'persisted') AND rowid IN (<rowids>)`; a `sent` row's message may then be missing from the chat history. `claimed`: the outcome is unknown. Look in the channel: if the message arrived, or must no longer be sent, write what the tag's suppression writes (l.432-440): `UPDATE channel_outbound_receipts SET state = 'suppressed', suppression_reason = 'settled at thread-fence adoption', completed_at = <now>, claim_owner = NULL, claim_expires_at = NULL, updated_at = <now> WHERE state = 'claimed' AND rowid IN (<rowids>)`. If it did not arrive and must still go, do not write: `abandon`, start `3.261113.2`, which retakes an expired claim when its job is redelivered with `resend_prohibited = 0` (l.251-262), and adopt again after it settles.

A grant `applying` (operator's act, Luís) is settled only if its effect is in place (`ravi permissions list` shows the grant for that subject and scope): `UPDATE permission_grant_applications SET status = 'done', updated_at = <now> WHERE status = 'applying' AND idempotency_key = '<key>'`. `result_json` stays empty, so a later click with the same key applies again instead of replaying. If the effect is not in place, leave the row and postpone: applying a grant again is a decision of its own.

Mail and calendar outbox rows `leased` or `sending` (operator's act, Luís): the tag has no writer that resumes them. Before requeueing a `sending` row, confirm on the provider's side that it was not sent. Requeue with the same write as the tag's own retry command (`mailbox/db.ts` l.868-880, `calendar/db.ts` l.1069-1080): `UPDATE mail_outbox SET status = 'pending', next_attempt_at = 0, last_error_code = NULL, updated_at = <now> WHERE status IN ('leased', 'sending') AND rowid IN (<rowids>)` (same for `calendar_outbox`). This release's outbox dispatcher then sends it.

Unexpired `pr_publication_leases` and `console_inbox_poll_locks` block only until their `expires_at`; the label says until when: wait for it, then `retry`. Nothing to write.

Credential attempts left `reserved` or `started` do not block. To clean them up (optional, and also the operator's act, Luís; an open row only biases the pool's order, `credential-pool.ts` l.52), write what the tag's abandon writes (`runtime/credential-store.ts` l.618-650), in the credentials database: `UPDATE runtime_credential_attempts SET status = 'abandoned', classifier_kind = NULL, classifier_confidence = NULL, completed_at = <now>, metadata_json = NULL WHERE status IN ('reserved', 'started') AND completed_at IS NULL AND rowid IN (<rowids>)`.

**60-minute window and the restart snapshots.** The legacy stop writes the restart epoch to `~/.ravi/restart-reason.txt` before anything else (tag `src/daemon.ts` l.249-272), and `bot.stop` then snapshots every non-idle session with its pending messages, first and synchronously (tag `src/bot.ts` l.179-185, `session-dispatcher.ts` l.400-470). This release's boot resumes that epoch's eligible sessions only within 60 minutes of the stop (`src/daemon.ts` l.660-700, `src/router/router-db.ts` l.7123-7152). The coordinator and the successor read the same epoch with the same eligibility: within the window, less a 10-minute margin for the successor's boot, the sessions are carried; past it, or without an epoch in the file, the adoption is refused, because nobody would resume them. The 10-minute margin is a choice, not a measurement: the successor's boot on a production-size database was never timed. Adoption and recovery never touch `restart-reason.txt`. If a block keeps production down close to 50 minutes, decide before then: settle and `retry`, or `abandon` and start `3.261113.2` at once (it resumes the same epoch within the same 60 minutes).

When the snapshots block, send the messages again by hand, record each session as delivered so that no resume repeats it, then `retry`. Read them (read only; the epoch is the `restartEpoch` field of `~/.ravi/restart-reason.txt`), skipping sessions a resume already delivered:

```sh
sqlite3 -readonly -json "${RAVI_STATE_DIR:-$HOME/.ravi}/ravi.db" "
  SELECT s.session_key, s.session_name, s.stopped_at, json_extract(m.value, '$.message.content') AS text
    FROM daemon_restart_session_snapshots s, json_each(s.pending_messages_json) m
   WHERE s.restart_epoch = '<epoch>' AND s.non_idle = 1
     AND NOT EXISTS (SELECT 1 FROM daemon_restart_resume_deliveries d
                      WHERE d.restart_epoch = s.restart_epoch AND d.session_key = s.session_key)
   ORDER BY s.session_name, json_extract(m.value, '$.queuedAt')"
```

Each entry is a queued user message of the tag (`createQueuedRuntimeUserMessage`, `src/runtime/delivery-queue.ts` l.38-52): `text` is the prompt as it was queued, header included. Send each one again, in order, with `ravi sessions send <session_name> "<text>"`; a session snapshotted with no pending messages was interrupted mid-turn and gets one message saying the daemon restarted. Then, as the operator's act (Luís), record each session as delivered, as the resume itself does: `INSERT INTO daemon_restart_resume_deliveries (restart_epoch, session_key, session_name, delivery_kind, decision_reason, delivered_at) VALUES ('<epoch>', '<session_key>', '<session_name>', 'notice', 'resent by hand at thread-fence adoption', <now>)`.

**PM2's kill timeout.** `pm2 stop` sends SIGINT and then SIGKILL after the registration's `kill_timeout`; the tag's launchers set none (`src/daemon-stdin.ts` l.108-127, `src/cli/commands/channels.ts` l.308), so PM2's default (1600 ms) applies, while the legacy shutdown gives itself 15 s (`src/daemon.ts` l.244-247). What the successor needs from the shutdown, the epoch and the snapshots, is written first and synchronously, so 1600 ms covers it unless SQLite is held by another writer; a SIGKILL cuts only the rest of the shutdown. Credential attempts are left `started` with any timeout, because the stop does not wait for the turn's `finally` that abandons them (`src/bot.ts` l.192, l.212-223): they are counted, not blocking. See the values without printing every process's environment: `pm2 jlist | jq '.[] | select(.name == "ravi" or .name == "ravi-channels") | {name, kill_timeout: .pm2_env.kill_timeout}'` (absent means the default). Raising it means registering the process again with the tag's own arguments plus `--kill-timeout 20000` (PM2 6.0.14 takes it as a start option, `lib/binaries/CLI.js` l.55), for example `pm2 delete ravi && pm2 start <bundle> --name ravi --interpreter <stdin wrapper> --interpreter-args bun --kill-timeout 20000 -- daemon run`, while the installed bundle is still `3.261113.2` (before step 1). It restarts the legacy and changes its registration: the operator's decision. After the stop, check that `restart-reason.txt` names an epoch.

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
