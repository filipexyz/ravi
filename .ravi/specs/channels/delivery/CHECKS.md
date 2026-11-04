# Channel Delivery Checks

- [ ] Outbound delivery MUST create a durable job before platform send.
- [ ] Delivery jobs MUST include request id, target chat/thread, origin session and idempotency key.
- [ ] A runner MUST acknowledge a job only after sent, failed, cancelled, suppressed or dead-letter state is persisted.
- [ ] Ambiguous send timeouts MUST NOT blindly retry when the platform lacks idempotency.
- [ ] Delivery state MUST NOT overwrite runtime status.
- [ ] Runtime status MUST NOT be inferred from delivery receipts.
- [ ] Tool presentation MUST come from registered runtime metadata and the concrete invocation, never downstream tool-name heuristics.
- [ ] Tool presentation MUST redact credentials, content, patches, environment values and local paths before channel projection.
- [ ] Tool start and completion MUST preserve one stable presentation and terminal duration without exposing raw output.
- [ ] Unknown tools MUST retain their exact normalized name and use a safe fallback presentation.
- [ ] A successful provider send MUST create a SQLite receipt keyed by idempotency key before canonical persistence or telemetry.
- [ ] Provider send MUST be preceded by an atomic owner lease and immutable request fingerprint claim.
- [ ] An active foreign claim MUST NAK without provider send; an expired claim MAY resume with the same provider idempotency token.
- [ ] Reusing an idempotency key with a different request fingerprint MUST fail closed.
- [ ] Retrying a `sent`, `persisted` or `complete` receipt MUST NOT call the provider again.
- [ ] Suppressing an unsent claim MUST persist `suppressed` and its reason without a provider identity or sent timestamp. A different owner/fingerprint MUST NOT overwrite it.
- [ ] Suppressed receipt/outbox retries after elapsed cooldown MUST stay terminal. A telemetry failure MUST resume without sending; reconciliation MUST NOT release a suppressed backlog.
- [ ] Post-send persistence, trace or telemetry failure MUST NAK for phase resumption and MUST NOT emit `send_error`.
- [ ] Trace and telemetry MUST document at-least-once delivery and carry the idempotency key for consumer deduplication; telemetry MUST flush NATS successfully before the receipt becomes complete.
- [ ] Delivery telemetry and trace MUST include canonical message id, real platform/provider message id, provider timestamp and idempotency key.
- [ ] Slack sends MUST use a deterministic UUID `client_msg_id` derived from the request idempotency key as a provider-dependent duplicate-suppression token, not an exactly-once guarantee.
- [ ] Adapter sends MUST finish within the claim lease, renew it, or rely on provider-side idempotency for the stable token.
- [ ] Receipts MUST be retained for at least 14 days since their last update, then pruned at startup and periodically without deleting active claim leases or retaining raw provider responses. Compact suppressed receipts and outbox tombstones MUST survive payload pruning so old keys cannot reopen.
- [ ] Publish-outbox reconciliation MUST coalesce identical provider-unavailable notices per delivery destination (channel, account, instance, chat and thread) into one delivery, MUST also close matching duplicates pending beyond the current reconciliation batch, and MUST NOT coalesce arbitrary repeated chat text.
- [ ] Compact automatic terminal-part receipts and no-resend claims MUST survive pruning/restart. Retention alone MUST NOT disable stable-token text retry after an expired claim.
- [ ] Canonical send-part identity MUST remain separate from wrapper publication identity; wrapper changes MUST NOT add provider sends or terminal debits, and changed immutable fingerprints MUST fail closed.

- [ ] `outbound-publish-outbox.test.ts` MUST cover save-then-throw exact readback,
  finished pre-save missing, unknown readback and post-save bookkeeping failure;
  only the missing pre-save phase may authorize bounded host retry.
- [ ] `output-handoff.test.ts` MUST validate full output/key/request identity,
  permanent fingerprint conflict and strict non-authorizing generic confirmation.
