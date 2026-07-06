# Channel Delivery Checks

- [ ] Outbound delivery MUST create a durable job before platform send.
- [ ] Delivery jobs MUST include request id, target chat/thread, origin session and idempotency key.
- [ ] A runner MUST acknowledge a job only after sent, failed, cancelled or dead-letter state is persisted.
- [ ] Ambiguous send timeouts MUST NOT blindly retry when the platform lacks idempotency.
- [ ] Delivery state MUST NOT overwrite runtime status.
- [ ] Runtime status MUST NOT be inferred from delivery receipts.
