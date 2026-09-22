---
id: channels/slack/approval
title: Slack Authorized Approval
kind: feature
domain: channels
capability: slack
feature: approval
capabilities:
  - slack
  - block-kit
  - permissions
tags:
  - slack
  - approval
  - grantor
  - block-kit
applies_to:
  - src/approval/service.ts
  - src/approval/decision.ts
  - src/approval/grantor.ts
  - src/approval/store.ts
  - src/approval/slack-blocks.ts
  - src/channels/slack/text-send.ts
  - src/channels/slack/socket-mode.ts
  - src/gateway.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Slack Authorized Approval

## Intent

Native Slack permission, plan, and spec approvals MUST resolve through
authorized Block Kit Approve/Reject buttons. WhatsApp/Omni keep
reaction/reply UX. Every channel MUST enforce the same server-side grantor
rule: only an actor who already has authority to grant the requested
permission may approve.

## Invariants

- Slack approval messages MUST use Block Kit with versioned action ids
  `ravi.approval.v1.approve` and `ravi.approval.v1.reject`.
- Button `value` MUST contain only the opaque request id. Decision MUST come
  from `action_id`, never from `value`, emoji, or client-supplied claims.
- Slack copy MUST NOT tell the user to react with 👍 or ❤️.
- Approval MUST subscribe to `ravi.inbound.interaction` for Slack and MUST
  NOT treat Slack `reaction_added` / `ravi.inbound.reaction` as an approval
  decision. Event Subscriptions for reactions are not required for this path.
- WhatsApp/Omni MUST keep reaction-to-approve and reply-to-reject UX.
- Authorization MUST load the pending request record and check the actor
  through `resolvePlatformIdentity` / contact identity plus
  `materializeSubjectCapabilities` and `canWithCapabilities`. Admin contact
  tags (`permission-admin`, `permission-owner`, `permission-superadmin`) keep
  granting `admin:system:*`. Plan/spec requests without a permission triple
  MUST require `admin:system:*`.
- Unauthorized, stale, expired, wrong-message, wrong-account, or wrong-chat
  events MUST fail closed: no grant, no runtime turn, no first-valid claim.
- Correlation MUST use request id + message id + account/chat + authorized
  actor + unexpired window (default 5 minutes) + single-use. First valid
  decision wins.
- After a valid Slack decision or timeout, the original message MUST be
  updated to remove buttons and show a compact final state when
  `chat.update` is available.
- Inbound approval interactions MUST reuse `ravi.inbound.interaction` and
  MUST NOT create a session prompt or runtime turn.

## Acceptance Criteria

- An authorized Slack Approve click grants the pending capability without
  timeout.
- An authorized Slack Reject click denies the request and persists no
  capability.
- An unauthorized Slack user cannot approve.
- An authorized WhatsApp 👍 / ❤️ still approves.
- An unauthorized WhatsApp reaction cannot approve.
- A second valid decision is ignored after the first claim.
- Expired or stale events do not grant.
- Slack reactions never settle an approval waiter.
- Typecheck and the quality gate pass for the changed files.
