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
- A cloud approval reply from a held colleague MUST reach the run.
- With no owner tagged the shared session MUST keep its legacy behaviour.
- An unreadable owner set MUST hold the DM.
- The sole owner's verified DM in `agent:<id>:main` MUST count as the
  operator's turn when only their own chats (their DMs and threads inside
  them) are attached and every route naming the session reaches one direct
  peer. It MUST be refused while another person's chat (or a thread of it) is
  attached, while a `group:`, `thread:` or glob route names the session, and
  while no owner or a second owner is tagged. A contact other than the owner
  MUST stay refused there.
- `bun test src/channels/owner-dm-guard.test.ts src/channels/owner-dm-guard.routing.test.ts`,
  `bun test src/link/connector-turn.test.ts -t "shared session"`,
  `bun test src/channels/slack/socket-mode.test.ts -t "Slack owner DM guard"` and
  `bun test src/omni/consumer-context.test.ts -t "owner DM guard"` SHOULD pass
  after changing this behaviour.
