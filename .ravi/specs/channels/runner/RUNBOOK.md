# Channel Runner Runbook

## Expected Startup Checks

Before the runner opens any platform connection:

1. Load channel runner config.
2. Connect to Ravi NATS and the router database.
3. Ensure required streams or queues exist.
4. Validate enabled adapter manifests.
5. Resolve only the credential metadata needed for startup.
6. Acquire runner process lock.
7. Acquire scoped platform locks for each enabled channel.
8. Start adapters after locks are held.

## Debugging A Duplicate Consumer

1. Check runner status for active channel locks.
2. Check whether another process owns the same scoped Slack app/workspace lock.
3. Inspect stale PID/runtime lock diagnostics.
4. Stop or replace the old runner before opening a new Socket Mode connection.
5. Confirm only one runner reports the Slack channel as connected.

## Debugging Lost Or Delayed Outbound

1. Find the outbound job by request id or idempotency key.
2. Check whether the job is queued, claimed, sending, retrying, failed or dead-lettered.
3. Check runner health and adapter health.
4. Check delivery attempt logs and redacted provider errors.
5. Verify whether the runner restarted while the job was in flight.
6. Confirm the job was either requeued or marked terminal.
7. A job stuck `pending` with a healthy adapter and a recent `created_at` can be
   a runner left on the previous release: its reconcile loop logs
   `STATE_SCHEMA_NOT_READY` on every pass. Compare `runtime.*.runningVersion`
   in `ravi channels status --json`; the runner relaunches itself after 3
   refusals (see "Package and environment drift"), and the job publishes once
   the new process is up.

## Debugging Credential Failure

1. Verify the channel config references a brokered connection, not a raw token.
2. Check runner capabilities for the requested credential/action.
3. Check broker denial reason and audit event.
4. Confirm the secret value was not printed in logs or status output.

## Shutdown

On shutdown the runner must:

1. Stop accepting new platform events where possible.
2. Disconnect adapters cleanly.
3. Requeue or finish in-flight outbound jobs.
4. Release scoped platform locks.
5. Release runner process lock.

## Package and environment drift

1. Run `ravi daemon status --json` or `ravi channels status --json`.
2. Compare `runtime.*.runningVersion` with `diskVersion`, and inspect
   `codeStale`, `envStale`, `identityVerified` and `warnings`. A healthy
   transport can still run obsolete code. Null runningVersion is unknown.
3. For each named process, run the printed explicit command when intake may
   restart: daemon first with `ravi daemon restart -m "reconcile installed runtime"`,
   then `ravi channels restart`. Do not restart automatically from monitoring.
4. Recheck status; alignment must be based on the new process receipts.
5. External package-manager writes cannot emit Ravi command warnings; the
   next status read detects those file changes. `ravi update` warns immediately.
6. A runner refused by the state guard (daemon restarted onto a newer release,
   runner not) restarts itself: after 3 consecutive `STATE_SCHEMA_NOT_READY`
   refusals of the publish reconcile loop (within about 90 s of the daemon
   moving to the new release) and only while the
   installed bundle is a different release from the running one, it logs
   `Channel runner is on an older release than the state its daemon prepared;
   relaunching onto the installed release` and exits with status 75, and PM2
   starts the installed bundle. The same refusals with matching releases mean
   the daemon has not prepared state yet: start the installed daemon; the runner
   does not restart. Still run `ravi channels restart` after installing a
   release rather than waiting for the relaunch.
7. The same drift is readable without the log. `ravi channels status` reports
   health `degraded (release_drift)` and the restart command in its warnings, and
   `ravi doctor --domain channels` fails `channels.runner_release`. A
   `degraded (state_refused)` health is the runner saying its guard refuses it
   while the releases match: prepare state with the daemon
   (`ravi daemon restart -m "prepare state"`), not by restarting the runner.
   `unverified` (doctor `skip`) means a process has no boot receipt yet, as in a
   status read right after a restart: read it again before acting.
