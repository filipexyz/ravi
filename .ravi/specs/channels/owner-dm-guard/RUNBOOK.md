# Owner DM Guard / RUNBOOK

- A colleague says the bot ignores their DM: list held DMs with
  `ravi instances pending list <instance>`. Let them in with an explicit route to a
  dedicated agent, for example
  `ravi instances routes add <instance> <platform-user-id> <agent> --session <name>`.
- The owner's own DM is held: the owner contact is not tagged
  `permission-owner`, or the sender's platform identity is linked to another
  contact. Tag the right contact and check the identity link.
- To trace a held omni DM: `ravi sessions trace` shows `route.rejected` with
  `dm_owner_session_non_owner`.
