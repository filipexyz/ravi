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

## Durable Outbound Boundary

Outbound channel delivery MUST use a durable delivery boundary between the Ravi runtime daemon and channel adapters.

Runtime responses destined for channels MUST become delivery jobs before platform send. A channel runner MUST consume those jobs and perform rendering/delivery through the selected adapter.

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
