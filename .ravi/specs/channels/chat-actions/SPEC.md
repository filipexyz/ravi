---
id: channels/chat-actions
title: "Channel Chat Actions"
kind: capability
domain: channels
capabilities:
  - chat-actions
  - capabilities
  - delivery
tags:
  - channels
  - chat-actions
  - messages
  - permissions
applies_to:
  - src/channels/chat-actions.ts
  - src/channels/capabilities.ts
  - src/channels/native/types.ts
  - src/channels/outbound-stream.ts
  - src/channels/outbound-consumer.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Channel Chat Actions

## Intent

Chat actions are typed Ravi operations over a chat or message target. Discovery,
authorization and execution MUST share one capability contract so agents are
never told that an action is available when no adapter can execute it.

## Canonical Model

The model MUST define:

- `ChatActionDescriptor`;
- `ChatActionAvailability`;
- `ChatActionRequest`;
- `ChatActionResult`;
- `ChatActionUnavailableReason`.

Initial stable action ids are:

- `message.edit`;
- `message.delete`;
- `message.react`;
- `media.send`;
- `sticker.send`;
- `message.reply`.

Discovery status MUST be `available`, `unavailable`, or `planned`.

Unavailable reasons MUST use stable codes. The initial codes are:

- `no_surface`;
- `unsupported_channel`;
- `missing_connection`;
- `missing_scope`;
- `permission_denied`;
- `invalid_target`;
- `unverifiable_ownership`;
- `no_eligible_resource`;
- `adapter_unavailable`.

## Availability

- Availability MUST be resolved for one concrete channel surface.
- `available` MUST require an implemented command and adapter path.
- Surface presence alone MUST NOT make an action available.
- Credential, known scope, permission and target constraints MUST participate
  when they are known at discovery time.
- Unknown provider scope state MUST be exposed as unverified metadata and MUST
  still fail explicitly at execution if the provider rejects the action.
- `planned` MUST NOT expose an executable command.
- Native and bridge-backed adapters MUST publish capabilities through the same
  resolver. Feature code MUST NOT spread provider conditionals across CLIs.

## Execution

An external mutation MUST do one of the following:

1. return `succeeded` only after the provider confirms the operation; or
2. durably enqueue the request and return `queued` with a request id and
   idempotency key.

Publishing an event is not provider confirmation. A command MUST NOT return
`success: true` merely because a pub/sub publish completed.

Durable chat-action jobs MUST follow `channels/delivery` for claims, retries,
receipts and terminal telemetry. A job MUST carry canonical and platform target
identity. Reusing an idempotency key with different input MUST fail closed.

Edit and delete persistence MUST happen only after provider confirmation.
Reaction accounting remains owned by `channels/chats/reactions`.

## Permissions

- Every executable action MUST have command access metadata.
- Provider calls and external side effects MUST be `mutate` with at least
  `risk: high`.
- Delete MUST be `risk: destructive`.
- Discovery MUST NOT expose raw credentials or tokens.

## Boundaries

- `channels/chat-actions` owns cross-channel action semantics.
- `sessions/actions` owns projection into a concrete session.
- Provider features such as `channels/slack/chat-actions` own native mappings.
- Workspace administration remains outside this capability.
