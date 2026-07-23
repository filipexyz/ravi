# Channel Delivery Runbook

1. Verify the outbound job has a stable request id and idempotency key.
2. Confirm the target channel, instance, chat and optional thread are present.
3. Inspect `channel_outbound_receipts` by idempotency key and compare the stored `request_fingerprint` before retrying a send.
4. If `claimed` by another live lease, NAK without sending. If the lease expired, reclaim it and reuse the same provider idempotency token.
   The default lease is five minutes; investigate any adapter request that can remain in flight beyond it.
5. If the receipt is `sent`, resume canonical persistence; if it is `persisted`, resume trace/telemetry; if it is `complete`, acknowledge without provider work.
6. Treat `last_error_phase` as the recovery starting point. Post-send errors are not provider `send_error` failures.
7. Treat trace and delivery telemetry as at-least-once and deduplicate consumers by `idempotencyKey` where duplicates matter. Verify telemetry publish is followed by a successful NATS flush before `complete` is stored.
8. If no sent receipt exists after an ambiguous Slack attempt, retry with the same deterministic `client_msg_id`. Treat it as a stable token for Slack's duplicate-suppression support, not an exactly-once guarantee.
9. Confirm `provider_message_id` is the real platform id and not a Ravi composite delivery id.
10. Confirm pruning runs at startup and every six hours, removes any receipt state whose `updated_at` is at least 14 days old, preserves newer receipts and active claim leases, and does not store raw provider responses.
11. Persist terminal failure, cancellation or dead-letter state before acknowledging the job.
12. Keep runtime status updates separate from delivery state updates.
