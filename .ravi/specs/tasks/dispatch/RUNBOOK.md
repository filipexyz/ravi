# Task Dispatch Runbook

## Inspect A Dispatch

1. `ravi tasks show <task-id>` shows the durable task state and active
   assignment. An assignment that is dispatched but not accepted indicates the
   dispatch reached `enqueued` but not `accepted`.
2. Check whether a runtime acceptance acknowledgement was recorded for the
   dispatch key. Enqueue success alone MUST NOT be read as acceptance.

## Diagnose A Stuck Dispatch

1. Determine the current dispatch state: `intent`, `enqueued`, `timed_out`,
   `retry_scheduled`, `payload_conflict`, `dead_letter`, or `repair_required`.
2. `intent` with no enqueue receipt: core was not reached. Confirm the core
   session port is reachable, then let retry re-enqueue with the same dispatch
   key.
3. `enqueued` with no acknowledgement past the acceptance window: the dispatch
   is `timed_out`. The remote result is unknown — retry with the same key; do
   not mint a new key and do not force `accepted`.
4. `payload_conflict`: the same dispatch key was reused with a different payload
   hash. Do not overwrite. Inspect both hashes in the repair evidence and
   resolve which payload is canonical; a corrected dispatch uses a new key.
5. `dead_letter`: retries are exhausted. Repair requires a new dispatch key
   (typically a fresh dispatch of the task) after the underlying cause is fixed.

## Diagnose Premature Delivery Or Eviction

1. If a prompt was delivered while a task was still active, or a task session
   was evicted with work in flight, suspect an `unavailable` work read being
   treated as `missing`.
2. Confirm the `after_task` barrier and retention/eviction paths defer (not
   deliver/evict) when the active-task check cannot be resolved.

## Verify Port Boundaries

1. Runtime modules MUST read task state through the work port, not by importing
   `src/tasks/task-db.ts` functions directly.
2. Work modules MUST enqueue prompts through the core session port, not through
   `publishSessionPrompt` in `src/omni/session-stream.ts`.
3. Neither port may perform a cross-store transaction or join.

## Replay Safety Check

1. Re-issuing the same dispatch (same key + same payload hash) MUST NOT create a
   second assignment, prompt, or acceptance.
2. Re-issuing with a changed payload hash MUST surface `payload_conflict`, not a
   silent overwrite.
