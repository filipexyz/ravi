# Owner DM Guard / CHECKS

## Checks

- A DM from the tagged owner MUST reach `agent:<id>:main` when the agent's DM
  scope is `main`, or when a route forces that session.
- A DM from any other sender MUST NOT reach `agent:<id>:main` or a thread forked
  from it, whatever routes (literal or glob, with or without a forced session)
  or attached chats (by routing, a person or an agent) say; it MUST be held as
  account-pending and emit `ravi.contacts.pending` once.
- The guard MUST judge the key the commit lands in: a route that forces the
  shared session MUST NOT admit a colleague, and the preview MUST equal the
  committed key.
- A route that gives the colleague a session of their own (`dmScope` other
  than `main`, or a forced session that already exists) MUST still deliver to
  that route's agent; a forced name that does not exist yet on a shared-scope
  agent MUST keep holding them.
- A route that names the shared session with spaces around the name MUST
  count like the trimmed name the router uses.
- A DM from another app's bot MUST NOT land in the shared session.
- A cloud approval reply from a held colleague MUST reach the run.
- With no owner tagged the shared session MUST keep its legacy behaviour.
- An unreadable owner set MUST hold the DM.
- The owner's verified DM in `agent:<id>:main` MUST count as the operator's
  turn whatever else the session holds; the guard MUST NOT be read as a
  privacy check (`cli/connectors`, "Owner read confirmation").
- `bun test src/channels/owner-dm-guard.test.ts src/channels/owner-dm-guard.routing.test.ts`,
  `bun test src/link/connector-turn.test.ts -t "counts in any session"`,
  `bun test src/channels/slack/socket-mode.test.ts -t "Slack owner DM guard"` and
  `bun test src/omni/consumer-context.test.ts -t "owner DM guard"` SHOULD pass
  after changing this behaviour.
