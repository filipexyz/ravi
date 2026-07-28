---
id: channels/delivery
title: "Channel Delivery"
kind: capability
domain: channels
capabilities:
  - delivery
tags:
  - delivery
applies_to:
owners:
status: active
normative: true
---

# Channel Delivery

## Scope

This spec defines outbound requests, delivery results and delivery state.

## OutboundRequest

`OutboundRequest` MUST include:

- request id
- channel id
- instance id
- target chat id
- optional target thread id
- actor/session origin metadata
- content
- attachments
- rendering options
- idempotency key
- policy hints

## DeliveryResult

`DeliveryResult` MUST include:

- request id
- status
- platform message identity when available
- canonical message id when created
- timestamp
- retryability
- error code and message when failed
- provider metadata when retained

The provider message identity MUST be the platform's real message id. A Ravi display or composite delivery id MUST NOT be stored as `providerMessageId`. Provider timestamps MUST be retained when returned by the platform. Canonical persistence and delivery telemetry MUST expose the canonical message id, platform/provider message id, provider timestamp and idempotency key.

## Delivery States

Delivery state MUST support:

- queued
- claimed
- rendering
- sending
- sent
- delivered
- read
- failed
- cancelled
- dead_lettered
- unknown

## Runtime Status Boundary

Delivery state describes the lifecycle of an outbound request and its resulting channel message. Runtime status describes what an agent/session is doing.

Delivery state and runtime status MAY be rendered near the same outbound message, but they MUST remain separate canonical concepts.

When a delivery job creates or updates an outbound `ChannelMessage`, the resulting canonical message id SHOULD become the preferred `ChannelStatusAnchor` for subsequent runtime status from the same origin session in the same chat/thread until a newer outbound message from that session exists.

Delivery receipts MUST NOT be interpreted as agent runtime status. Agent runtime status MUST NOT overwrite delivery state.

## Tool Activity Presentation

Channel runtime events MAY carry a bounded, provider-neutral presentation for
each tool lifecycle. The runtime host, not a provider adapter or downstream
client, owns this presentation.

The presentation MAY contain:

- the registered tool description;
- canonical capability/resource category;
- read, mutate, execute, or ask operation;
- declared risk;
- a bounded summary and parameter list derived from the invocation;
- terminal duration.

Descriptions and semantic metadata MUST come from the runtime tool registry.
Invocation values MUST be allowlisted, bounded, and sanitized before channel
projection. Credentials, authorization material, Message content, patches,
environment values, local paths, provider-native payloads, and raw tool output
MUST NOT enter the presentation.

Unknown tools fall back to their exact normalized name without downstream
lexical inference. A downstream client MUST NOT translate or tokenize a tool
name to invent its meaning. The opaque tool-call id remains lifecycle
correlation metadata and need not be displayed.

## Durable Outbound Boundary

Outbound channel delivery MUST use a durable delivery boundary between the Ravi runtime daemon and channel adapters.

Runtime responses destined for channels MUST become delivery jobs before platform send. A channel runner MUST consume those jobs and perform rendering/delivery through the selected adapter.

Native edit, delete and reaction actions that return `queued` MUST use this
same durable boundary. Their request content MUST remain distinguishable from a
new text-message delivery, and terminal action telemetry MUST identify the
action id and target message.

Core NATS pub/sub MAY be used as a notification mechanism, but it MUST NOT be the only source of truth for user-visible outbound delivery. Audit streams MAY capture delivery history, but audit history MUST NOT replace the delivery workqueue.

The delivery job MUST include:

- canonical `OutboundRequest`;
- target channel and instance;
- target chat and optional thread;
- origin session and response metadata;
- idempotency key;
- attempt count and next retry time;
- terminal state and error fields when applicable.

The channel runner MUST acknowledge the job only after:

- sent or delivered state is persisted;
- terminal failure is persisted;
- cancellation is persisted;
- dead-letter state is persisted after retry policy is exhausted.

If the runner exits during delivery, the job MUST be redelivered, requeued or reconciled by idempotency.

## Durable Post-Send Receipt

The channel runner MUST atomically claim an idempotency key before platform send. A claim MUST retain an immutable fingerprint of the canonical outbound request, an owner token and a bounded lease. A runner MUST negatively acknowledge without sending while another owner's lease is active. An expired claim MAY be acquired by a new owner, but the adapter MUST receive the same provider idempotency token. Reusing an idempotency key with a different request fingerprint MUST fail closed.

After a successful platform send, the claim owner MUST durably record the provider receipt with an owner-checked compare-and-swap. Its recoverable states are:

1. `claimed`: one runner owns a bounded provider-send lease;
2. `sent`: provider message identity and timestamp are durable;
3. `persisted`: canonical persistence has completed, including the explicit no-canonical-context result;
4. `complete`: delivery telemetry has been published, the NATS server has confirmed the connection flush and the workqueue job may be acknowledged.

A redelivery with a `sent`, `persisted` or `complete` receipt MUST NOT call the provider send again. It MUST resume only the missing phases. Failures after a successful provider send MUST be recorded against their phase and MUST NOT be reported as `send_error`. The job MUST be negatively acknowledged until the missing phase succeeds. A complete receipt MUST make repeated processing a no-op that acknowledges the job.

Trace and delivery telemetry are at-least-once side effects: a process can exit after recording or publishing them but before recording the next SQLite state. Their payloads MUST include the request idempotency key, and consumers MUST deduplicate by that key when duplicate observations matter. `complete` MUST only be recorded after the telemetry publish returns and a NATS connection flush confirms that the server processed the publish. A failed flush MUST leave the receipt resumable and re-emit telemetry on retry.

Receipts MUST be retained for at least twice the outbound workqueue's seven-day maximum age and then pruned by their last update time. This applies to complete receipts and to orphaned `claimed`, `sent` or `persisted` receipts after their source job has expired. Pruning MUST run at startup and periodically while the daemon remains alive, and MUST NOT delete any receipt updated inside the 14-day window or any claim whose lease is still active. Provider raw responses MUST NOT be retained in the receipt ledger; only the identities and timestamps required for recovery belong there.

Providers with native idempotency support SHOULD receive a deterministic provider token derived from the request idempotency key. Slack `chat.postMessage` MUST receive a stable UUID `client_msg_id` as a duplicate-suppression token. This reduces duplicate risk only to the extent that Slack honors that field; Ravi MUST NOT describe it as an exactly-once guarantee.

The default provider-send lease is five minutes. An adapter MUST normally finish before its claim expires. If it can remain in flight longer, it MUST either renew the claim before expiry or provide provider-side idempotency for concurrent retries with the stable token; otherwise it MUST fail closed instead of allowing an ambiguous resend.

## Rules

1. Delivery MUST be idempotent by request id or idempotency key.
2. Rendering failure and transport failure MUST be distinguishable.
3. Retries MUST respect platform limits and route policy.
4. Receipts MUST update delivery state instead of creating unrelated messages.
5. Edit/delete operations MUST use canonical message identity plus platform delivery identity.
6. Concurrency strategy SHOULD be explicit per chat or route: drop, queue, debounce, burst or concurrent.
7. Ambiguous send timeouts MUST NOT blindly retry if the platform might have accepted the send and no idempotency guarantee exists.
8. Delivery ownership MUST be singular for a given job. Two channel runners MUST NOT claim and send the same job concurrently.
9. The runtime daemon MUST NOT be required to stay alive after producing a delivery job for the channel runner to finish delivery.
10. Delivery MUST preserve enough origin session metadata for status anchoring to select the last outbound message for that session and chat/thread.
11. Provider send, durable receipt and canonical persistence MUST remain separately resumable phases; trace and telemetry remain explicitly at-least-once.
12. The durable receipt MUST preserve the first successful provider response for an idempotency key.
