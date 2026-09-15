# React agent-first CLI contract / CHECKS

## Checks

- `react send <mid> <emoji> --json` from a routed session MUST emit
  immediately, with no `--execute` flag in the signature (unbraked verdict).
- A call without channel source context MUST exit 1 with the
  `NO_CHANNEL_CONTEXT` envelope and MUST NOT emit.
- A message id unknown to a LEDGERED current chat MUST exit 1 with
  `MESSAGE_NOT_FOUND` and up to three `suggestions` of recent provider ids,
  and MUST NOT emit.
- A chat absent from the local ledger MUST fail open: the reaction is emitted
  normally (no false not-found on ledger gaps).
- A Slack context without `canonicalChatId` MUST exit 1 with `INVALID_TARGET`.
- The sessions hint MUST keep teaching `ravi react send <message-id> <emoji>`
  without `--execute`, consistent with the unbraked verdict.
- `bun test src/cli/commands/media-json.test.ts` SHOULD pass after any change
  to the react contract surface.
