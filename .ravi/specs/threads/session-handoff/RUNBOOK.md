# Thread Session Handoff Runbook

## Send A Thread To A Session

```bash
ravi sessions send dev --thread rafa-pricing "continua daqui"
ravi sessions send dev --thread rafa-pricing --thread-title "Dúvidas com Rafa sobre pricing" "primeiro comentário"
```

The command resolves the target session, resolves (or creates, when creation
facts are complete) the thread, appends the send message as a thread entry,
builds a bounded brief, records the handoff, and enqueues one prompt to the
target session.

## Inspect A Handoff

1. `ravi sessions send ... --json` returns `thread.id`, `thread.slug`,
   `threadHandoff.id`, included entry/link counts, and whether the thread was
   created during send.
2. The handoff audit row records who initiated it, origin/target session,
   target thread, created-vs-reused, included entry/link ids, brief snapshot
   hash / renderer version, delivery barrier, and outcome.

## Diagnose A Stuck Or Undelivered Handoff

Determine the handoff state: `intent`, `enqueued`, `delivered`, `timed_out`,
`retry_scheduled`, `payload_conflict`, `dead_letter`, or `repair_required`.

1. `intent`/`queued` with no enqueue receipt: core was not reached durably.
   Confirm the core session port is reachable, then let retry re-enqueue with
   the same idempotency key. Do NOT hand-flip status to `delivered`.
2. `enqueued` but never `delivered`: a durable core receipt for the same handoff
   id and payload hash has not been observed. Inspect the receipt/ack ledger;
   re-check the acknowledgement rather than re-rendering a new payload.
3. `timed_out`: remote result unknown. Retry with the same key after backoff.
4. `payload_conflict`: the same handoff key was reused with a different payload
   hash. Do not overwrite. Inspect both hashes in repair evidence; a corrected
   handoff uses a new handoff id/key.
5. `dead_letter`: retries exhausted. Repair by issuing a new handoff after the
   underlying cause is fixed.

## Diagnose A Duplicate Prompt

1. A duplicate delivered prompt usually means retry minted a new key or the
   delivered mark happened before a durable receipt.
2. Verify replay with the same key + same payload hash is a no-op and that
   `delivered` is set only after a durable core enqueue receipt.

## Diagnose Premature "Delivered" On Store Unavailability

1. If a handoff is marked delivered while the work store was degraded, suspect
   an `unavailable` read treated as `missing` or a delivered mark on publish
   return.
2. Confirm delivery defers on `unavailable` and that the delivered mark requires
   a durable core receipt.

## Verify Boundaries

1. Work modules MUST enqueue the handoff prompt through the typed core session
   port, not through `publishSessionPrompt` directly.
2. The cross-store delivery MUST reference the shared storage outbox/receipt
   protocol once available and MUST NOT introduce a second generic outbox.
