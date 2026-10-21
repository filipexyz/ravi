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
  - src/approval/slack-click-feedback.ts
  - src/approval/timeouts.ts
  - src/bash/hook.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/tool-liveness.ts
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
authorized Block Kit Approve/Reject buttons, sent privately to the people
who can grant the request and to nobody else. WhatsApp/Omni keep
reaction/reply UX. Every channel MUST enforce the same server-side grantor
rule: only an actor who already has authority to grant the requested
permission may approve. An approval MUST work end to end: an approved
request is honored, every click gets an answer, and a request nobody can
grant fails at once instead of holding the turn.

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
  `materializeSubjectCapabilities` and the capability snapshot matcher
  (`canWithCapabilities`). Button values, emoji, and client claims MUST NOT
  be treated as authority. Admin contact tags (`permission-admin`,
  `permission-owner`, `permission-superadmin`) keep granting `admin:system:*`.
  Plan/spec requests without a permission triple MUST require `admin:system:*`.
- Unauthorized, stale, expired, wrong-message, wrong-account, or wrong-chat
  events MUST fail closed: no grant, no runtime turn, no first-valid claim.
- Correlation MUST use request id + message id + account/chat + authorized
  actor + unexpired window (default 5 minutes) + single-use. First valid
  decision wins.
- Slack approval cards MUST NOT be posted publicly. The card MUST go only to
  the Slack users of the request's instance (configured aliases plus the
  empty legacy scope) whose identity is owned by a contact that passes the
  grantor rule for that request, capped at 20 people. Each one MUST receive
  it as an ephemeral message (`chat.postEphemeral`) in the request's chat and
  thread; when Slack refuses that (usually `user_not_in_channel` or
  `channel_not_found`) the person MUST receive it in their DM with the app
  instead. A card MUST never fall back to a public post. Every delivery MUST be recorded per person in
  `approval_request_deliveries`.
- When no Slack user can grant the request, no card MUST be sent and the
  request MUST be refused at once with a reason that says nobody linked to
  the workspace holds the permission.
- Delivering the card MUST time out after 30 seconds
  (`DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS`), not the approval window.
- A click on a private card MUST count only from the person the card was
  sent to, in the chat it was sent to (and, for a DM card, on that message).
  Ephemeral cards are correlated by person, not by message ts, because only
  that person can see or click them.
- After a valid Slack decision, the clicker's ephemeral card MUST be replaced
  through the click's `response_url` and every DM card MUST be updated with
  `chat.update`, removing the buttons and naming who decided. A request
  without recorded deliveries (legacy public card) keeps the `chat.update`
  of its single message. On timeout, DM cards MUST be updated.
- Every click that decides nothing MUST be answered privately to the
  clicker through its `response_url`: missing permission (card kept),
  expired, already decided by someone else (naming who), or unknown request
  (card replaced). A second click from whoever decided MUST stay silent.
  These answers MUST NOT decide or grant anything.
- A capability granted by approval (`source: "approval"` on the context)
  MUST be honored by the Bash check for that context, even when the agent's
  live ceiling does not include it, and MUST cover only what was approved.
- While an authorization waits on a person, the running tool's inactivity
  window MUST cover the approval window (`APPROVAL_GATED_TOOL_TIMEOUT_MS`)
  and return to the tool's own window when the wait ends.
- Inbound approval interactions MUST reuse `ravi.inbound.interaction` and
  MUST NOT create a session prompt or runtime turn.

## Acceptance Criteria

- Only people who can grant the request receive the Slack card, privately.
- A request nobody in the Slack can grant is refused at once, without a card.
- An authorized Slack Approve click grants the pending capability without
  timeout, and an approved executable runs.
- Every click gets a private answer.
- An authorized Slack Reject click denies the request and persists no
  capability.
- An unauthorized Slack user cannot approve.
- An authorized WhatsApp 👍 / ❤️ still approves.
- An unauthorized WhatsApp reaction cannot approve.
- A second valid decision is ignored after the first claim.
- Expired or stale events do not grant.
- Slack reactions never settle an approval waiter.
- Typecheck and the quality gate pass for the changed files.
