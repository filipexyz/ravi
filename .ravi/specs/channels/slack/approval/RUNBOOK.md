# Runbook

## Inspect a pending approval

```bash
sqlite3 ~/.ravi/ravi.db "SELECT id, channel, message_id, status, permission, object_type, object_id, expires_at FROM approval_requests ORDER BY created_at DESC LIMIT 5;"
```

## Confirm Slack delivery used buttons

Approval outbound payloads on Slack MUST include `blocks` with
`ravi.approval.v1.approve` / `ravi.approval.v1.reject` and MUST NOT include
“Reaja com 👍”.

## Confirm no runtime turn from a click

Socket Mode publishes `ravi.inbound.interaction` and does not call
`publishPrompt` for `block_actions`.

## See who received a card

```bash
sqlite3 ~/.ravi/ravi.db "SELECT request_id, user_id, kind, chat_id FROM approval_request_deliveries ORDER BY created_at DESC LIMIT 10;"
```

No rows and a refused request mean nobody who can grant it has their Slack
user linked to their contact on that instance (`ravi contacts check <contact>`).

## Confirm grantor failure

If someone without the permission clicks Approve, they get a private
"you don't have the permission" answer and the row stays `pending` until an
authorized grantor decides or the 5-minute window expires.

## Validation commands

```bash
bun test src/approval/service.test.ts
bun test src/approval/grantor.test.ts
bun test src/approval/decision.test.ts
bun test src/approval/store.test.ts
bun test src/approval/slack-blocks.test.ts
bun test src/channels/slack/inbound-reaction.test.ts
bun test src/channels/slack/text-send.test.ts
bun test src/approval/slack-click-feedback.test.ts
bun test src/runtime/host-services.approval.test.ts
bun run typecheck
```
