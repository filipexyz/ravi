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

## Confirm grantor failure

If a non-admin Slack user clicks Approve, the row stays `pending` until an
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
bun run typecheck
```
