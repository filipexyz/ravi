# Owner Authority / RUNBOOK

- Is this turn acting with owner authority? `ravi sessions trace <session>
  --explain` and look for `ownerAuthority: contact:<id>` in the turn context.
- Owner turn still cut by the agent: check the contact's global tags
  (`ravi permissions materialize --subject-type contact --subject-id <id>`
  must show `admin:system:*`) and whether a chat grant with a `deny_*` covers
  that chat (`ravi permissions list --chat <chat>`).
- Remove someone's owner authority: remove the owner/admin tag or
  `ravi permissions deny permission-owner --to contact:<id> --force --apply`;
  the next turn is back under the agent's ceiling.
