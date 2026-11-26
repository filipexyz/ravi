# Owner DM Guard / RUNBOOK

- A colleague says the bot ignores their DM: list held DMs with
  `ravi instances pending list <instance>`. Let them in with a session of
  their own, for example
  `ravi instances routes add <instance> <platform-user-id> <agent> --dm-scope per-peer`
  (add `--session <name>` to name it), or give a dedicated agent
  `ravi agents set <agent> dmScope per-peer`. A route into an agent whose DMs
  share one session (`dmScope: main`) still holds them, even with
  `--session <name>`: a forced name that does not exist yet lands in the
  shared key. Approving the pending contact alone does not route them.
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
- The owner's DM was refused or asked for a confirmation: that is not this
  guard. See `cli/connectors`, "Owner read confirmation", and the `pages/read`
  and `knowledge` runbooks.
- To trace a held omni DM: `ravi sessions trace` shows `route.rejected` with
  `dm_owner_session_non_owner`.
