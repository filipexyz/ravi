# React agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/react --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `1` + `NO_CHANNEL_CONTEXT`: the command only works from a routed
   channel session — reactions always target the current chat; there is no
   `--to` override.
4. Exit `1` + `MESSAGE_NOT_FOUND`: read `error.suggestions` — recent real
   provider ids from the current chat. Use a `[mid:ID]` from a visible message
   or inspect `ravi sessions actions --json`.
5. Exit `1` + `INVALID_TARGET` (Slack): the session source lost its
   `canonicalChatId`; re-run from the Slack-routed session.
6. Reaction accepted but not visible in the chat: the emit succeeded and the
   channel side dropped it — check gateway logs, not this contract.
7. If `react send` starts demanding `--execute`, the unbraked verdict was
   silently reverted — check the rationale comment and signature in
   `src/cli/commands/react.ts` against this spec.

## Validation

```bash
bun test src/cli/commands/media-json.test.ts
```

Live checks (from a routed session):

```bash
ravi react send <mid-from-visible-message> 👍 --json   # immediate emit
ravi react send mid-inexistente 👍 --json              # MESSAGE_NOT_FOUND on ledgered chats
```
