# Channel Delivery Checks

- [ ] Outbound delivery MUST create a durable job before platform send.
- [ ] Delivery jobs MUST include request id, target chat/thread, origin session and idempotency key.
- [ ] A runner MUST acknowledge a job only after sent, failed, cancelled or dead-letter state is persisted.
- [ ] Ambiguous send timeouts MUST NOT blindly retry when the platform lacks idempotency.
- [ ] Delivery state MUST NOT overwrite runtime status.
- [ ] Runtime status MUST NOT be inferred from delivery receipts.
- [ ] A successful provider send MUST create a SQLite receipt keyed by idempotency key before canonical persistence or telemetry.
- [ ] Provider send MUST be preceded by an atomic owner lease and immutable request fingerprint claim.
- [ ] An active foreign claim MUST NAK without provider send; an expired claim MAY resume with the same provider idempotency token.
- [ ] Reusing an idempotency key with a different request fingerprint MUST fail closed.
- [ ] Retrying a `sent`, `persisted` or `complete` receipt MUST NOT call the provider again.
- [ ] Post-send persistence, trace or telemetry failure MUST NAK for phase resumption and MUST NOT emit `send_error`.
- [ ] Trace and telemetry MUST document at-least-once delivery and carry the idempotency key for consumer deduplication; telemetry MUST flush NATS successfully before the receipt becomes complete.
- [ ] Delivery telemetry and trace MUST include canonical message id, real platform/provider message id, provider timestamp and idempotency key.
- [ ] Slack sends MUST use a deterministic UUID `client_msg_id` derived from the request idempotency key as a provider-dependent duplicate-suppression token, not an exactly-once guarantee.
- [ ] Adapter sends MUST finish within the claim lease, renew it, or rely on provider-side idempotency for the stable token.
- [ ] Every receipt state MUST be retained for at least 14 days since its last update, then pruned at startup and periodically without deleting active claim leases or retaining raw provider responses.
