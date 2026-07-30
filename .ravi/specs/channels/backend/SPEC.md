---
id: channels/backend
title: "Channel Backend"
kind: capability
domain: channels
capabilities:
  - backend
  - ingress
  - runtime-events
  - local-actions
tags:
  - native-channel
  - idempotency
  - durability
applies_to:
  - src/channels/backend.ts
  - src/channels/runtime-events.ts
  - src/channels/native/
  - src/channels/slack/
  - src/router/router-db.ts
owners:
  - dev
status: active
normative: true
---

# Channel Backend

## Intent

Provide one provider-neutral boundary from an admitted external Channel
message to Ravi's canonical Chat, Message, Session, Turn, runtime events, and
outbound correlation. Provider adapters retain transport-specific
normalization and policy, but MUST NOT implement a second prompt-ingress
backend.

## Terms

- `external identity`: provider, connection, conversation, sender, and Message
  references retained as provenance.
- `canonical binding`: Ravi Channel instance, Agent, Chat, Message, Session,
  and Turn references accepted for one ingress.
- `wire ingress`: a scoped native driver request whose local identity can be
  derived by the backend.
- `resolved ingress`: an in-process native adapter request that already has a
  Ravi route, canonical Chat/Message, and Session.
- `ingress receipt`: durable idempotency, binding, publication state, and
  external correlation for one logical inbound Message.

## Admission and Ownership

- A native provider MUST normalize and admit transport input before calling
  the backend.
- Provider admission MAY include signature/envelope checks, deduplication,
  account policy, thread policy, actor resolution, file processing, route
  resolution, and canonical provider Chat/Message persistence.
- Ravi route and local authorization decisions MUST remain outside transport
  delivery code.
- A wire ingress MUST be scoped by the native driver host to its configured
  provider and Channel instance.
- A resolved ingress MUST reference an existing canonical Chat, Message,
  Session, and Agent that all match the accepted route.
- The backend MUST reject missing Agents, mismatched canonical references,
  malformed scope, and idempotency conflicts before publication.

## Durable Acceptance

For one `(channelInstanceId, idempotencyKey)`, the backend MUST atomically
persist or resolve:

- immutable request fingerprint;
- initial request identity and external identity;
- local actor and Agent;
- canonical Chat and Message;
- stable Session and Turn;
- acceptance time;
- publication state and bounded claim.

Equivalent retries MUST return the same binding. Conflicting payload reuse
MUST fail closed. Process restart or concurrent delivery MUST publish at most
one claimed prompt for the accepted receipt. A publication failure MUST leave
the receipt retryable without creating another Message or Turn.

Transport acknowledgement is not backend acceptance. When a provider requires
an acknowledgement before normalization can finish, the adapter MUST first
persist a bounded provider inbox record that can retry the exact envelope and
backend idempotency key. Provider inbox claims and backend publication claims
MUST both recover after expiry or restart.

## Canonical Prompt Path

- Ordinary inbound messages from Slack, loaded native drivers, and future
  native providers MUST converge on the same backend publication function.
- A provider adapter MUST NOT call `publishSessionPrompt` directly for an
  ordinary admitted inbound message.
- The published prompt MUST preserve the provider-normalized human-readable
  prompt, structured source/context, delivery barrier, active actor metadata,
  and a backend correlation envelope.
- The correlation envelope MUST bind the runtime Turn to the accepted ingress
  receipt and external target without making provider IDs canonical.
- Provider-specific system interactions that are not user prompt ingress MAY
  use their own typed event paths.

## Runtime and Output

- Runtime events MUST use the accepted canonical binding and monotonically
  increasing sequence.
- Commentary, tool activity, deltas, terminal assistant content, failure, and
  interruption MUST remain distinct typed events.
- A terminal assistant result MUST persist before terminal completion is
  reported.
- Output sinks MUST be selected by provider and connection and MUST remain
  bounded and explicitly registered.
- Runtime status and delivery status MUST remain separate.

## Local Agent Actions

- A native driver MAY register bounded, typed local Agent actions through the
  host ABI.
- Registration and discovery MUST be scoped to provider, Channel instance,
  source account, active Agent, Session, and current source context.
- The Channel runner and runtime daemon are separate processes. The backend
  MUST snapshot only the matching bounded descriptors into its trusted
  accepted-turn correlation envelope before prompt publication.
- Runtime discovery MUST accept that snapshot only when its provider and
  account exactly match the current turn source.
- Invocation MAY cross an internal request/reply bridge to the runner-local
  handler, but the bridge MUST carry no new authority and MUST validate the
  complete typed request and correlated typed result.
- Duplicate ambiguous tool names MUST fail closed.
- Invocation MUST require the runtime's normal local tool permission
  immediately before the handler runs unless the descriptor explicitly makes
  the driver handler the final authorization boundary.
- No responder, timeout, malformed frame, correlation mismatch, source
  mismatch, duplicate ownership, or runner restart MUST fail closed. Runtime
  MUST NOT fall back to shell or another mutation surface.
- Descriptors and results MUST be bounded and provider-neutral. Product Roles,
  memberships, hosted policy, and hosted product entities MUST NOT enter this
  contract.

## Provider Boundary

The OSS backend MAY know:

- provider/connection/conversation provenance;
- canonical Ravi Chat, Message, Session, Turn, Agent, and actor context;
- neutral content blocks, safe errors, runtime events, local actions, and
  output targets.

It MUST NOT know hosted Organizations, Members, Bots, product Channels, Roles,
commercial policy, private endpoint schemas, or private authorization rules.

## Validation

- Wire ingress accepts once, retries across restart, and rejects conflicting
  reuse.
- Resolved ingress reuses the adapter's canonical Chat, Message, Session, and
  Agent without creating a parallel Chat.
- Concurrent accepted deliveries publish one prompt.
- Publication failure resumes from the durable receipt.
- Slack and a fixture native driver both produce backend receipts before
  prompt publication.
- Slack persists a secret-redacted bounded envelope before Socket Mode ack,
  then resumes normalization and backend acceptance after failure or restart.
- Processed provider inbox records are retained only for a bounded
  deduplication window and are pruned without removing pending work.
- Slack preserves thread, actor, file, route, subscription, and delivery
  behavior after convergence.
- Runtime readback and output correlation resolve from the accepted binding.
- Local actions remain provider/account/source scoped and locally authorized.
- A two-process fixture proves one accepted turn advertises the exact action,
  invokes the runner-local handler once, and fails closed without a runner.

## Known Failure Modes

- Treating provider envelope acknowledgement as backend acceptance.
- Letting Slack or another adapter publish a parallel prompt directly.
- Creating a second canonical Chat for a resolved provider message.
- Deriving Session ownership from provider identity alone.
- Allowing a driver to escape its provider or Channel-instance scope.
- Retrying publication by creating another Message or Turn.
- Putting hosted product policy or entities in the public ABI.
