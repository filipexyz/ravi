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
- Slack approval delivery MUST carry `privateTo` with only the grantors, and
  MUST send nothing when there is none (the request is refused at once).
- Private cards MUST be ephemeral in the chat, falling back to the person's DM
  with the app when they are not in it.
- A click MUST count only from the person a private card was sent to.
- After a decision the clicker's card MUST be replaced through `response_url`
  and DM cards updated with `chat.update`; legacy single-message requests keep
  `chat.update`.
- A click that decides nothing MUST get a private answer and MUST NOT grant.
- An approved `execute:executable:<x>` MUST pass the Bash check for that
  context and MUST NOT allow other executables.
- An approval wait MUST extend the running tool's inactivity window and give
  it back when the wait ends.
- `bun test src/approval src/channels/slack/text-send.test.ts src/bash/hook.test.ts src/runtime/tool-liveness.test.ts src/runtime/runtime-request-builder.crash-recovery.test.ts src/runtime/host-services.approval.test.ts` MUST pass.
- `bun run typecheck` MUST pass.
