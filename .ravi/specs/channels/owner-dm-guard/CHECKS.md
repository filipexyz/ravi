# Owner DM Guard / CHECKS

## Checks

- A DM from the tagged owner MUST reach `agent:<id>:main` when the agent's DM
  scope is `main`.
- A DM from any other sender MUST NOT reach `agent:<id>:main` without an
  explicit route or explicit attach; it MUST be held as account-pending.
- A system (bookkeeping) attach of a colleague's chat to the shared session
  MUST NOT exempt the colleague.
- An explicit route for the colleague MUST still deliver to that route's agent.
- With no owner tagged the shared session MUST keep its legacy behaviour.
- An unreadable owner set MUST hold the DM.
- `bun test src/channels/owner-dm-guard.test.ts` and
  `bun test src/channels/slack/socket-mode.test.ts -t "Slack owner DM guard"`
  SHOULD pass after changing this behaviour.
