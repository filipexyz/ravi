# Channel Delivery Runbook

1. Verify the outbound job has a stable request id and idempotency key.
2. Confirm the target channel, instance, chat and optional thread are present.
3. Check the delivery job state before retrying a send.
4. If the adapter reports an ambiguous timeout, reconcile platform message identity before retrying.
5. Persist terminal failure, cancellation or dead-letter state before acknowledging the job.
6. Keep runtime status updates separate from delivery state updates.
