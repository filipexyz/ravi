# Checks

- Slack approval delivery MUST include Block Kit buttons with action ids
  `ravi.approval.v1.approve` and `ravi.approval.v1.reject`.
- Slack approval copy MUST NOT tell the user to react with 👍 or ❤️.
- Button value MUST be the opaque request id only.
- An authorized Slack Approve click MUST grant the pending capability.
- An authorized Slack Reject click MUST deny and MUST NOT persist a capability.
- An unauthorized Slack user MUST fail closed and MUST NOT approve.
- Slack `reaction_added` MUST NOT settle the approval waiter.
- Authorized WhatsApp 👍 / ❤️ MUST still approve.
- Unauthorized WhatsApp emoji MUST NOT approve.
- First valid decision MUST win; a second click MUST NOT change the claim.
- Expired or stale events MUST fail closed.
- Slack approval interactions MUST NOT create a runtime turn.
- After decide or timeout, Slack MUST update the message and remove buttons
  when `chat.update` is available.
- `bun test src/approval/service.test.ts` MUST pass.
- `bun run typecheck` MUST pass.
