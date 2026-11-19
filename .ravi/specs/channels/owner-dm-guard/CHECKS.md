# Owner DM Guard / CHECKS

## Checks

- A DM from the tagged owner MUST reach `agent:<id>:main` when the agent's DM
  scope is `main`, or when a route forces that session.
- A DM from any other sender MUST NOT reach `agent:<id>:main` or a thread forked
  from it without an explicit route or explicit attach; it MUST be held as
  account-pending and emit `ravi.contacts.pending` once.
- The guard MUST judge the key the commit lands in: a wildcard route that
  forces the shared session MUST NOT admit a colleague, and the preview MUST
  equal the committed key.
- A glob route pattern MUST NOT count as naming the colleague.
- A system (bookkeeping) attach of a colleague's chat to the shared session
  MUST NOT exempt the colleague, and a literal route MUST NOT vouch for a DM
  that such an attach reroutes into the shared session.
- An explicit route for the colleague MUST still deliver to that route's agent.
- A cloud approval reply from a held colleague MUST reach the run.
- With no owner tagged the shared session MUST keep its legacy behaviour.
- An unreadable owner set MUST hold the DM.
- With no owner tagged, `ravi doctor` MUST warn (`permissions.owner_contact`,
  `bun test src/cli/commands/doctor.test.ts -t permissions.owner_contact`), so
  the fail-open state does not go unreported.
- `bun test src/channels/owner-dm-guard.test.ts src/channels/owner-dm-guard.routing.test.ts`,
  `bun test src/channels/slack/socket-mode.test.ts -t "Slack owner DM guard"` and
  `bun test src/omni/consumer-context.test.ts -t "owner DM guard"` SHOULD pass
  after changing this behaviour.
