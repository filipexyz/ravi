# Owner DM Guard / RUNBOOK

- A colleague says the bot ignores their DM: list held DMs with
  `ravi instances pending list <instance>`. Let them in with a session of
  their own, for example a route to a dedicated agent with a forced session,
  `ravi instances routes add <instance> <platform-user-id> <agent> --session <name>`.
  A route into an agent whose DMs share one session (`dmScope: main`), with no
  forced session, still holds them; approving the pending contact alone does
  not route them.
- The route exists and the DM is still held: the route sends the person into a
  shared session, or the colleague's chat is attached to the shared session
  from an earlier DM and that attach outranks the route. On Slack a route with
  `--session` replaces routing's own attach; otherwise detach the chat with
  `ravi sessions detach <shared-session> --chat <chat-id>`.
- The owner's own DM is held: the owner contact is not tagged
  `permission-owner`, or the sender's platform identity is linked to another
  contact. Tag the right contact and check the identity link.
- Nothing is held and colleagues still reach the shared session: no contact is
  tagged `permission-owner`, so the guard is off (fail-open). Tag the owner.
- The owner's own DM in the shared session is refused as the operator's turn
  (`CONNECTOR_GROUP_BLOCKED` with `sharedSession`, `pages read` with
  `details.turn: shared_session`, `[knowledge] audience=none`): from the
  operator's terminal, `ravi sessions subscriptions <shared-session> --json`
  lists the attached chats (inside an agent turn it prints `{}`); detach every
  chat that is not the owner's DM or a thread inside it. Remove or narrow any
  route whose `--session` is the shared session and whose pattern is a glob,
  `group:` or `thread:`. Check that only one contact is tagged
  `permission-owner`.
- To trace a held omni DM: `ravi sessions trace` shows `route.rejected` with
  `dm_owner_session_non_owner`.
