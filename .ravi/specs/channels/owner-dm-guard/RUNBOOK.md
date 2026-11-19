# Owner DM Guard / RUNBOOK

- A colleague says the bot ignores their DM: list held DMs with
  `ravi instances pending list <instance>`. Let them in with a route whose
  pattern is their literal platform id, to a dedicated agent, for example
  `ravi instances routes add <instance> <platform-user-id> <agent> --session <name>`.
  A pattern with `*` does not count; approving the pending contact alone does
  not route them.
- The route exists and the DM is still held: the colleague's chat is probably
  attached to the shared session from an earlier DM
  (`ravi sessions subscriptions <shared-session>` lists it), and that attach
  outranks the route. On Slack a route with `--session` replaces routing's own
  attach; otherwise detach the chat with
  `ravi sessions detach <shared-session> --chat <chat-id>`. Re-attaching it
  with `ravi sessions attach` does not help: the existing attach keeps its
  `system` provenance.
- The owner's own DM is held: the owner contact is not tagged
  `permission-owner`, or the sender's platform identity is linked to another
  contact. Tag the right contact and check the identity link.
- Nothing is held and colleagues still reach the shared session: no contact is
  tagged `permission-owner`, so the guard is off (fail-open). Tag the owner.
  `ravi doctor --domain permissions` reports it as `permissions.owner_contact`
  and also warns when more than one contact carries the tag.
- To trace a held omni DM: `ravi sessions trace` shows `route.rejected` with
  `dm_owner_session_non_owner`.
