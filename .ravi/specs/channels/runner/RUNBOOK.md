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

## Debugging A Local Agent Action

1. Confirm the native runtime registered one unique action for the expected
   provider and account.
2. Confirm Channel-Backend prompt metadata contains the bounded descriptor.
3. Confirm runtime context source matches that descriptor envelope exactly.
4. Confirm the internal requester reaches the runner responder and preserves
   request/result correlation.
5. Treat no responder, timeout, mismatch, or retired handler as unavailable;
   never retry through shell.
