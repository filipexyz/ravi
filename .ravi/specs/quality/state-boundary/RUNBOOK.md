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

The installed `ravi` runs its commands in the terminal, on real state, with no gateway in between. It never creates or migrates a store there. When a command answers `STATE_SCHEMA_NOT_READY`, the daemon of this release has not prepared a store yet.

On a new install there is no database, and `ravi daemon restart` refuses a missing one. Start the daemon and retry once it has prepared state (PM2 shows it `online` before that):

```bash
ravi daemon start
```

After an update whose restart has not happened:

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

## Thread fence adoption (automatic, legacy database)

A release with the thread fence adopts a database that has no fence by itself, when its daemon starts. There is nothing to run, and deliberately no env flag, file-hash waiver or operator command. Once the fence exists, the entry does nothing and ordinary restarts and updates apply.

1. Upgrade as usual: `ravi update`, or install and `ravi daemon restart -m "upgrade"` (`ravi daemon start` when the daemon is stopped). On a pre-fence database the update and the restart stop the legacy channel runner and daemon first, so the new daemon never overlaps a legacy writer, then start the daemon on the installed bundle (a `ravi` registration on another bundle is replaced) and wait for its entry. Whoever stops a running `ravi-channels` for the upgrade (restart, update or the entry below) first writes `runtime-maintenance/channels-after-upgrade.json`.
2. The daemon entry (`daemon run`, before the command registry reads `ravi.db`), under the coordinator lease (`runtime-maintenance/coordinator.lock`, an OS lock released when the process dies):
   - checks, read only, that it is `ravi` under PM2 on its own bundle, that `ravi-channels` (if registered) starts the same bundle, that no other Ravi daemon is online, and that both predecessors left a boot receipt (`runtime-processes/`); then waits for the broker. A failure here refuses before anything is written or stopped;
   - takes the interlock and writes `adoption.json` (`preparing`) before the first stop;
   - stops `ravi-channels` through PM2 if it runs (the registration stays, so PM2 cannot relaunch it), and accepts only ESRCH, or a start before the current OS boot, as the exit of both predecessors;
   - re-reads the registry: no relaunch, no replacement, bundle unchanged;
   - reads the durable residue read only: router database (`ravi.db`) by status, and JetStream (`CHANNEL_OUTBOUND`, omni `MESSAGE`/`INSTANCE`/`REACTION` consumers, `SESSION_PROMPTS`);
   - writes evidence under `runtime-maintenance/evidence/<id>/`, claims the successor role for itself, installs the fence inside `withExitedThreadBootstrapAuthorization`, records `adopted` and releases the interlock last. It does not start `ravi-channels`: the daemon is not ready yet.
3. Once the daemon logs `Daemon ready`, it starts the runner an upgrade stopped, on its own bundle (recreating the registration when the update removed it or it starts another bundle), and removes `channels-after-upgrade.json`. A failed start keeps the file for the next ready daemon and logs `run 'ravi channels start'`. A runner the operator stopped has no such file and stays stopped. `ravi daemon restart` reports success only once the daemon is ready, and says whether the runner came back.
4. A refusal prints one line with its next step. Under PM2 the daemon then waits 30 s before exiting (refusals of the earlier admission check too), so PM2's restarts do not spin; each start reads everything again. Every refusal the entry reaches before the fence exists releases the interlock. A daemon killed inside that window (SIGKILL, power loss) leaves the interlock and records behind: the next daemon start settles them, and so do `ravi daemon start`, `ravi daemon restart`, `ravi update` and `ravi channels start`, under the same lease, once the successor recorded there has exited. `ravi daemon restart` reports the refusal it waited for (`runtime-maintenance/upgrade-failure.json`, a note for that CLI, never an authority).

What the residue read does with each table (the entry's read after the stops, and its read again inside the authorization, before it installs the fence):

- **Carried**: pending and in-flight work with a named owner in this release, counted in the evidence: prompt queue, turn attempts, ingress receipts, Slack inbound envelopes, recovery, outboxes, sync inbox, decision deliveries, jobs, broker consumers, adapters, library requests; Slack threads being created and turns in flight, which the gateway reconciliation resumes or recomputes at boot and every 30 s; Devin sessions, mirrors that no daemon process holds; cloud thread runs, whose events the Console keeps until this release's delivery runner applies them; workflow runs, recomputed from their tasks; credential attempts, records whose turn is carried by the turn attempts and the restart snapshots.
- **Restart snapshots**: the sessions the legacy stop left for the restart resume, read for the epoch named in `~/.ravi/restart-reason.txt`, with the successor's own eligibility. Carried until 60 minutes after the stop, less 10 minutes for the successor's boot; past that they block. When the file names no epoch, the successor would start a new one and resume nothing, so the snapshots this stop wrote (at or after the start of the stopped `ravi` process, recorded in `adoption.json`) block whatever their age (see the 60-minute window below).
- **Blocking, with a settle step** (label `resumption not verified`): values that no release resumes or recomputes. Each has its settle step below.
- **Unknown**: a value outside the tag's vocabulary (`owner not verified`), an unreadable table, an unreachable broker, prompts left in `SESSION_PROMPTS` (memory storage, 60 s, not durable).

Work tables are searched in every runtime database. Their terminal and at-rest values come from the tag's own types and writers; a value at rest carries its reason.

The complete table set of the tag is `src/threads/fence-adoption-inventory.ts`, derived from every `CREATE TABLE` of `v3.261113.2` by `bun scripts/fence-adoption-inventory.ts`. `fence-adoption-inventory.test.ts` (in `test:runtime-identity`) re-derives it from the tag and compares, reads each declared vocabulary from the tag, and fails when a table with a status, state, claim, lease or work-marker column has neither a rule nor an exclusion with a reason.

The runtime databases are those of `runtimeStateDatabasePaths` for the state directory; the credentials database follows `RAVI_CREDENTIALS_DB_PATH` from the environment of the process that runs the command, so run it with the same environment as the daemon.

**The exit for a blocking row is after the stop.** When the read after the stops lists blocking rows, the entry refuses with that list: the legacy processes have exited, the channel runner stays stopped, and every following start refuses again at its entry while anything blocks, so no writer of these tables is alive. That is when the settle step runs, with the operator's explicit authorization: nothing races the write, and "is the work of this row still running?" is already answered. The next start (PM2's, within 30 s, or `ravi daemon restart -m "upgrade"`) reads again and, with nothing blocking, adopts. This is the exit for rows the stop itself creates (a call or an admission it cut) as much as for old ones. Old ones can be listed with the label's read-only `SELECT` and settled the same way before the upgrade, under `3.261113.2`, to keep production down for less time. Watch the clock while settling: past the window the restart snapshots block too.

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
-- Operator's act (Luís). A cron run whose session never reported (cron/run-db.ts l.54). Limitation:
-- the row then shows as a failed run of its job, and the failure reporter announces it once
-- (l.71-75); the job's own outcome is not recorded (l.56-59).
UPDATE cron_runs SET status = 'error', finished_at = <now>,
       error = 'its session never reported; settled at thread-fence adoption'
 WHERE status = 'pending' AND rowid IN (<rowids>);
-- Operator's act (Luís). The runtime state of a channel turn the stop cut (router/router-db.ts
-- l.7710-7745). Limitation: this writes 2 of the 9 columns the upsert writes; the others keep the
-- last event's values. Nothing lists or reconciles these rows; readers go by turn_id.
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
-- The tag's writer measures from now when started_at is null (l.1669), hence the COALESCE.
UPDATE call_tool_runs SET status = 'failed', completed_at = <now>, duration_ms = <now> - COALESCE(started_at, <now>),
       error_message = 'the daemon stopped during the call (thread-fence adoption)'
 WHERE status IN ('pending', 'running') AND rowid IN (<rowids>);
```

Outbound receipts (operator's act, Luís), per state, in the database the label names. `sent` and `persisted`: the provider accepted the message; what is missing is the bookkeeping. Write what the tag's completion writes (`channels/outbound-receipts.ts` l.392-408): `UPDATE channel_outbound_receipts SET state = 'complete', completed_at = COALESCE(completed_at, <now>), last_error_phase = NULL, last_error_message = NULL, last_error_at = NULL, updated_at = <now> WHERE state IN ('sent', 'persisted') AND rowid IN (<rowids>)`. Limitation: settling `sent` straight to `complete` skips the `persisted` step (l.353-365), so that message is missing from the chat history; nothing sends it again. `claimed`: the outcome is unknown. Look in the channel: if the message arrived, or must no longer be sent, write what the tag's suppression writes (l.432-440): `UPDATE channel_outbound_receipts SET state = 'suppressed', suppression_reason = 'settled at thread-fence adoption', completed_at = <now>, claim_owner = NULL, claim_expires_at = NULL, updated_at = <now> WHERE state = 'claimed' AND rowid IN (<rowids>)`. If it did not arrive and must still go, do not write: reinstall and start `3.261113.2`, which retakes an expired claim when its job is redelivered with `resend_prohibited = 0` (l.251-262), and adopt again after it settles.

A grant `applying` (operator's act, Luís) is settled only if its effect is in place (`ravi permissions list` shows the grant for that subject and scope): `UPDATE permission_grant_applications SET status = 'done', updated_at = <now> WHERE status = 'applying' AND idempotency_key = '<key>'`. `result_json` stays empty, so a later click with the same key applies again instead of replaying. If the effect is not in place, leave the row and postpone: applying a grant again is a decision of its own.

Mail and calendar outbox rows `leased` or `sending` (operator's act, Luís): the tag has no writer that resumes them. Before requeueing a `sending` row, confirm on the provider's side that it was not sent. Requeue with the same write as the tag's own retry command (`mailbox/db.ts` l.868-880, `calendar/db.ts` l.1069-1080): `UPDATE mail_outbox SET status = 'pending', next_attempt_at = 0, last_error_code = NULL, updated_at = <now> WHERE status IN ('leased', 'sending') AND rowid IN (<rowids>)` (same for `calendar_outbox`). This release's outbox dispatcher then sends it.

Unexpired `pr_publication_leases` and `console_inbox_poll_locks` block only until their `expires_at`; the label says until when: wait for it; the next start reads again. Nothing to write.

Credential attempts left `reserved` or `started` do not block. To clean them up (optional, and also the operator's act, Luís; an open row only biases the pool's order, `credential-pool.ts` l.52), write what the tag's abandon writes (`runtime/credential-store.ts` l.618-650), in the credentials database: `UPDATE runtime_credential_attempts SET status = 'abandoned', classifier_kind = NULL, classifier_confidence = NULL, completed_at = <now>, metadata_json = NULL WHERE status IN ('reserved', 'started') AND completed_at IS NULL AND rowid IN (<rowids>)`.

**60-minute window and the restart snapshots.** The legacy stop writes the restart epoch to `~/.ravi/restart-reason.txt` before anything else, synchronously (tag `src/daemon.ts` l.249-272); `bot.stop` then snapshots every non-idle session with its pending messages, after an await (tag `src/bot.ts` l.179-185, `session-dispatcher.ts` l.400-470). This release's boot resumes that epoch's eligible sessions only within 60 minutes of the stop (`src/daemon.ts` l.660-700, `src/router/router-db.ts` l.7123-7152). The coordinator and the successor read the same epoch with the same eligibility: within the window, less a 10-minute margin for the successor's boot, the sessions are carried; past it the adoption is refused, because nobody would resume them. Without an epoch in the file, the snapshots this stop wrote are refused whatever their age, for the same reason. The 10-minute margin is a choice, not a measurement: the successor's boot on a production-size database was never timed. Adoption and recovery never touch `restart-reason.txt`; the successor's boot consumes it after the fence is installed (`src/daemon.ts` l.155-165, l.669). If a block keeps production down close to 50 minutes, decide before then: settle and let the next start adopt, or reinstall and start `3.261113.2` at once (it resumes the same epoch within the same 60 minutes, except sessions with a delivery row: after step (b) of the resend below, that is every session in the file, and only (e) brings their messages back).

When the snapshots block, the exit is these steps, in this order:

(a) Save what will be sent again, read only, before any write. The epoch is the `restartEpoch` field of `~/.ravi/restart-reason.txt` while that file exists. A successor's boot consumes the file (`src/daemon.ts` l.155-165, called from l.626 once the prompt consumer is up, l.616-618); after that, take the epoch from the adoption's evidence: `runtime-maintenance/evidence/<maintenanceId>/<attempt>/ravi.json`, in `residue.sources`, the entry `daemon_restart_session_snapshots`, field `detail.epoch`. When the file names no epoch, this stop's snapshots are those with `stopped_at` at or after the `startedAt` of the `ravi` predecessor in `runtime-maintenance/adoption.json`: use `s.stopped_at >= <that startedAt>` in place of the epoch condition below. If the read refuses that start time because it is not a positive integer, the record cannot bound this stop. Before the abandon, run the SELECT below with a time bound the operator chooses in place of the epoch condition (`s.stopped_at >= <chosen time>`, the time of this stop or a little before) and keep its output: it is the only list of that stop's pending messages outside the snapshot rows. Then reinstall and start `3.261113.2`, and upgrade again; the new adoption writes a new record with the stopped daemon's real start time. The `LEFT JOIN` also lists sessions with no pending message (interrupted mid-turn), which block the same way; the `JOIN` on `sessions` is the successor's own eligibility:

```sh
sqlite3 -readonly -json "${RAVI_STATE_DIR:-$HOME/.ravi}/ravi.db" "
  SELECT s.restart_epoch, s.session_key, s.session_name, s.stopped_at, s.pending_message_count,
         json_extract(m.value, '$.message.content') AS text, json_extract(m.value, '$.queuedAt') AS queued_at
    FROM daemon_restart_session_snapshots s
    JOIN sessions live ON live.session_key = s.session_key
    LEFT JOIN json_each(COALESCE(s.pending_messages_json, '[]')) m
   WHERE s.restart_epoch = '<epoch>' AND s.non_idle = 1
     AND (live.ephemeral = 0 OR live.expires_at IS NULL
          OR live.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
     AND NOT EXISTS (SELECT 1 FROM daemon_restart_resume_deliveries d
                      WHERE d.restart_epoch = s.restart_epoch AND d.session_key = s.session_key)
   ORDER BY s.session_name, queued_at" > resend-<epoch>.json
```

Each `text` is a queued user message of the tag (`createQueuedRuntimeUserMessage`, `src/runtime/delivery-queue.ts` l.38-52): the prompt as it was queued, header included. A row whose `text` is null is a session interrupted mid-turn with nothing queued.

(b) Record each session of the file as delivered, as the resume itself does, so that neither the successor's residue read nor its resume counts it again. This writes production rows: the operator's act (Luís), one row per session, with the `restart_epoch` of that session's rows: `INSERT OR IGNORE INTO daemon_restart_resume_deliveries (restart_epoch, session_key, session_name, delivery_kind, decision_reason, delivered_at) VALUES ('<restart_epoch>', '<session_key>', '<session_name>', 'notice', 'sent again by hand after thread-fence adoption', <now>)`. `OR IGNORE` makes the step safe to repeat if it stopped half-way. It also skips, without a word, a row that breaks a constraint (a `NOT NULL` column left empty, for example): a session whose row is missing shows up as (c) blocking again on the same snapshots, and its row has to be written correctly before the next retry. Never run (a) again once (b) has started: (a) skips delivered sessions, so a new file would drop them.

From here on `resend-<epoch>.json` is the only carrier of these messages. No release resumes these sessions any more, the legacy included: its resume skips every session with a delivery row (tag `src/router/router-db.ts` l.7134-7139). Keep the file. Whatever happens next, the recipe ends with (e) run from this file as soon as a daemon takes prompts: the new daemon after (c) and (d), or `3.261113.2` after an abandon (f).

(c) The next start adopts: PM2's own, within 30 s, or `ravi daemon restart -m "upgrade"` right after (b). Its read finds those sessions delivered, and the daemon starts. If it blocks on another source, settle that source and the start after it tries again, or go to (f); the file keeps the messages either way.

(d) Confirm the successor takes prompts before anything is sent. `ravi daemon logs` must show the line `Daemon ready` for this boot, that is, timestamped after the adopting start of (c): the line is logged only after the prompt consumer is ready (`src/daemon.ts` l.616-618), and an older one belongs to an earlier boot. The interlock is released earlier, when the daemon adopts, so a daemon online and no interlock do not prove a consumer on their own. Also check that `ravi daemon status` shows the daemon online on the target release and that `runtime-maintenance/` holds no `interlock` and no `adoption.json`. If no such `Daemon ready` line appears, nothing is sent: read the refusal in `ravi daemon logs` ("When something stops" below) and come back to (e) when a daemon logs it.

(e) Only then send each saved message again, from the file and without pasting any text into the shell, one entry at a time in the file's order, in a shell with `set -o pipefail` (bash or zsh). Run it from the operator's terminal, not from inside an agent session: from there the CLI wraps the text as `[System] Inform: [from: <session>] …` (`src/cli/session-cli-surface.ts` l.42-48), and the receipt below may not match. For entry `<N>` (counting from 0):

```sh
T=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)   # noted before sending; the receipt must not be older
jq -j --argjson n <N> '.[$n]
  | if (.session_name | type) != "string" or .session_name == "" or (.session_name | startswith("-"))
      then ("entry \($n): no usable session name; take it to the operator\n" | halt_error(2))
    elif (.text | type) != "string" or .text == "" or (.text | contains("\u0000"))
      then ("entry \($n): nothing to send\n" | halt_error(3))
    else .session_name + "\u0000" + .text end' resend-<epoch>.json \
  | xargs -0 -r -n 2 ravi sessions send -w --
```

The `jq` filter refuses an entry without a usable session name (null, empty or starting with `-`: take it to the operator) and an entry without text (null or empty: nothing to send; that session was interrupted mid-turn with nothing queued and stays idle until someone writes to it). It then writes nothing, `xargs -r` runs nothing, and with `pipefail` the command fails with the filter's message and code (2 or 3) instead of sending the word `null` or exiting 0 without sending. Checked with `printf` in place of `ravi`: a text with backticks, `$`, double quotes and a line break arrives as one intact argument, a text starting with `-` arrives after `--`, and the refused entries end with codes 3 and 2 and run nothing. Otherwise `jq -j` writes the session name and the text separated by a NUL byte, raw, with the text's real line breaks; `xargs -0` passes them as two arguments, so no backtick, `$` or quote reaches the shell; `--` ends the options, so a text starting with `-` is not read as one. The CLI is commander (`src/cli/index.ts` l.58); checked on this release: without `--`, a leading `-` is a usage error ("unknown option"), with `--` it arrives as the argument.

The receipt is the session's own record, not the exit code. `-w` only waits up to 120 s for a `turn.complete` of that session, of any turn, not necessarily this one, so its exit 0 proves nothing about this entry; on its timeout it fails with `SESSION_WAIT_TIMEOUT` (`src/cli/commands/sessions.ts` l.6326; tag l.6304). Whatever `-w` returned, read the session and look for a user line with this text recorded at or after `T`:

```sh
jq -j --argjson n <N> '.[$n].text' resend-<epoch>.json > expected-<N>.txt
ravi sessions read <session_name> -n 200 --json > read-<N>.json
jq --rawfile expected expected-<N>.txt --arg since "$T" -e '
  def rest: split("\n")[1:] | join("\n");
  [.messages[] | select(.role == "user" and (.createdAt // "") >= $since)
    | select(.text == $expected or (($expected | rest) != "" and (.text | rest) == ($expected | rest)))]
  | length > 0' read-<N>.json
```

The legacy wrote every one of these messages as a user line when it accepted it, before the stop. That line is not byte for byte the file's `text`: the file holds the queued runtime prompt (the surface line, the `[knowledge]`/contact-package line that `withKnowledgePreamble` adds, then the body; `src/knowledge/turn/preamble.ts` l.25-70), and the chat line has no `[knowledge]` line. Either way that old line is older than `T`, so only a line recorded for this send can match. The line recorded now is either the file's text itself, or the file's text with its first line (the session-surface line) replaced by the current one (`src/runtime/session-surface-hint.ts` l.42-75); a message that first came from the CLI or another session was recorded by the legacy without that first line. Hence the comparison: the whole text, or everything after the first line when there is something after it. `createdAt` has one-second precision, which is why `T` is taken before the send and compared with `>=`; `-n 200` must reach back to `T`: the oldest line returned is `jq -r '[.messages[].createdAt] | min' read-<N>.json`, and if it is newer than `T`, read again with a larger `-n`.

The `jq -e` above exits 0 when the line is there: the entry is closed, and it is not sent again. No line, whatever `-w` returned: an exit 0 can come from another turn of the same session, and the prompt can still sit in the debounce buffer (`src/runtime/session-dispatcher.ts` l.962-1028) or unconsumed in the stream. So wait 60 s, the life of a prompt in `SESSION_PROMPTS`, so that one still in flight is taken or expires, then read again. Still no line: note a new `T` and send that entry a second time from the file, then read the same way. If the second send also ends without the line, stop: take the entry to the operator with the file and the session's latest user lines (`jq '[.messages[] | select(.role == "user")] | .[-5:]' read-<N>.json`); its delivery row stays, so the file is still its only carrier. An entry is never sent more than twice. Every entry ends with its line read back, or with the operator.

(f) Abandon after (b), as a step and not as an exception: reinstall `3.261113.2` and start it. A refused entry already released the interlock, so there is nothing else to undo. It does not resume these sessions (see above). As soon as its `ravi daemon logs` shows a `Daemon ready` line timestamped after this start (the tag logs the same line, `src/daemon.ts` l.625), run (e) from the same file with the legacy's CLI, which has the same `sessions send -w` (tag `src/cli/commands/sessions.ts` l.4743), the same commander handling of `--`, and the same `sessions read --json` with `id` and `createdAt` (tag l.1496-1516).

Known limitations, to be proven in the rehearsal: the resent text carries the original header inside the new prompt that `sessions send` builds around it, so the session sees two headers; it also carries the old `[knowledge]`/contact-package line into the new prompt; and where the session's reply goes (its default chat or the thread the message came from) was not checked.

Why nothing can be sent before (d), checked in this release's code: the installed CLI on real state is a schema consumer (`src/db/state-boundary.ts` l.285-292), and the router database refuses a schema consumer while the fence is missing (`src/router/router-db.ts` l.1436-1443 → `src/threads/schema-fence.ts` l.120-124), so the command fails before it publishes. It does not reach the interlock check, which only process entrypoints make (`src/runtime-maintenance.ts` l.101-106), nor the daemon's gateway (the operator's CLI runs commands in its own process, `src/cli/operator-runtime.ts` l.27-33). A prompt published while no daemon consumes waits in `SESSION_PROMPTS`, a 60-second memory stream (`src/omni/session-stream.ts` l.74-81, l.236-245), and expires. The delivery records are true only once every entry of the file has its line read back in (e) or has been taken to the operator; until then the file is what keeps the messages. `src/threads/fence-adoption-glue.test.ts` compares this text: it pins the written order and wording, not the behavior.

**PM2's kill timeout.** `pm2 stop` sends SIGINT and then SIGKILL after the registration's `kill_timeout`; the tag's launchers set none (`src/daemon-stdin.ts` l.108-127, `src/cli/commands/channels.ts` l.308), so PM2's default (1600 ms) applies, while the legacy shutdown gives itself 15 s (`src/daemon.ts` l.244-247). The epoch is written first and synchronously; the snapshots follow inside `bot.stop`, after an await, so 1600 ms very likely covers them, but that was not measured, and a SIGKILL in between leaves an epoch without its snapshots. Credential attempts are left `started` with any timeout, because the stop does not wait for the turn's `finally` that abandons them (`src/bot.ts` l.192, l.212-223): they are counted, not blocking. See the values without printing every process's environment: `pm2 jlist | jq '.[] | select(.name == "ravi" or .name == "ravi-channels") | {name, kill_timeout: .pm2_env.kill_timeout}'` (absent means the default). Raising it means registering the process again with the tag's own arguments plus `--kill-timeout 20000` (PM2 6.0.14 takes it as a start option, `lib/binaries/CLI.js` l.55), for example `pm2 delete ravi && pm2 start <bundle> --name ravi --interpreter <stdin wrapper> --interpreter-args bun --kill-timeout 20000 -- daemon run`, while the installed bundle is still `3.261113.2` (before step 1). It restarts the legacy and changes its registration: the operator's decision. After the stop, check that `restart-reason.txt` names an epoch. If it does not, the successor would resume nothing: this stop's snapshots block until they go through the six steps (a) to (f) above, with the time condition in place of the epoch.

The inventory test reads `v3.261113.2` from git. A clone without the tag fails with `LEGACY_TAG_MISSING` and the command to fetch it: `git fetch --no-tags origin refs/tags/v3.261113.2:refs/tags/v3.261113.2` (the gate job checks out with `fetch-depth: 0`).

If the daemon entry reports "an adoption coordinator or recovery is running" and none should be: the holder is the process with `runtime-maintenance/coordinator.lock` open (`lsof` on that file). Stop that process; the kernel releases the lock when it exits. Never delete the lock file.

### When something stops

Every stop settles at the next daemon start, without a command. `ravi daemon logs` shows the refusal of each attempt; `ravi daemon restart -m "upgrade"` shows the last one.

| Stopped at | What is down | Exit |
|---|---|---|
| Entry refused before the interlock (not under PM2, another daemon online, a launcher on another bundle, no boot receipt, broker unreachable) | nothing was stopped by it | fix what the line names; the next start retries |
| Refused after the stop (an exit unproven, a relaunch, the bundle changed, residue blocking or unknown) | channels and the legacy daemon; the interlock is already released | settle what the line names (settle steps above); the next start reads everything again |
| Daemon killed mid-adoption, before the fence | channels, and the daemon if PM2 does not bring it back | the next daemon start (PM2's, `ravi daemon start`, `ravi daemon restart` or `ravi update`) releases the leftovers and adopts from scratch |
| Fence installed, interlock or records left behind (crash after the install), including a coordinator's from an earlier release | channels | the next start releases them; then it is an ordinary start |
| A successor that may still be running (alive, or its exit cannot be read) | both runtimes, or channels | the start refuses and PM2 retries; it finishes or exits by itself. If it hangs, `ravi daemon logs`, then `pm2 stop ravi` and `ravi daemon start`: with its exit proven, that start settles the leftovers |
| `adoption.json` or `active.json` corrupt (`*_CORRUPT`) | both runtimes | keep the files as evidence, stop and escalate; nothing settles a record it cannot read |

To give up on the upgrade: reinstall `3.261113.2` and start it; the legacy release does not know the interlock, and a refused entry has already released it. To try again, wait for the legacy runtime to settle the residue that blocked, then upgrade again.

Do not remove the interlock, the lease or the successor claim by hand (the lifecycle commands and the daemon entry settle them under the lease), downgrade schema markers, clear queues/claims, reset context or expire a lease to force progress. Canonical health/attention JOINs and legacy context provenance (resume and local recovery) remain gates before any cross-audience projection.

A failed shutdown drain must retain its failure while attempting the other component stops and exit nonzero. It must not tear down shared NATS/SQLite handles as though all accepted component work had settled. Neither a zero exit nor a scoped drain receipt replaces the external accepted-work verifier.

Inspect the shutdown result's named `failures`, `drain.phase` and exit code together. Nested stop/close failures preserve their original causes in an aggregate. `blocked` remains an unsuccessful shutdown even if another sibling or a later cleanup retry succeeds. Do not clear that result, reset queues or restart the live daemon to test it; use isolated failure-injection tests for Knowledge, SQLite, subscriptions and media.


For isolated CLI/fixture creation, `withNewIsolatedThreadState(parent, callback)` creates a private directory and exclusive database file. Seed an old schema and initialize it within the synchronous ownership callback; do not launch a runtime or share this state until initialization finishes. This is proof by creation/ownership, not a rule that temporary paths are safe.

An already-existing database requires `withExitedThreadBootstrapAuthorization` from reviewed coordinator code. The coordinator holds external launcher/admission exclusion throughout the synchronous callback and supplies complete inventory plus accepted-work evidence for both exact predecessors. The SQL boundary rechecks physical exits and evidence under the schema lock. The API neither stops/starts services nor releases an interlock; real-state process-role and entrypoint guards remain in force, so this does not complete the production rollout workflow.

Inspect `<database>.thread-bootstrap.jsonl` for `thread-bootstrap-authorized`, its reason and evidence references. This log records authorization before SQL, not successful installation or migration. Missing/failed audit persistence refuses installation. Do not manufacture an audit record or use it as reusable authorization.
