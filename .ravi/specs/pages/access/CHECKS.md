# Share Pages, invite and ask for access from the CLI / CHECKS

- The terminal, the owner's own direct chat and an owner routine MUST send no
  `actor`; a contact in a direct chat or a group MUST send
  `actor: { contactId }`.
- An unresolved sender, an agent relay without verified admission and an
  unresolvable context MUST fail with `ACTOR_UNKNOWN` (exit 3) and make no
  Console call.
- A verified relay MUST send its admitted person's `actor: { contactId }`,
  preserve the current executor and leave link/resource ACL enforcement to
  Console, even when that person is the operator
  (`src/access/delegated-actor.test.ts`). A hint or later human speaker MUST
  NOT replace host-verified caller/time/target lineage.
- Normal caller completion/rotation after admission MUST preserve queued
  attribution; explicit authority withdrawal and contact ineligibility or
  opt-out MUST deny it. The Slack producer integration lives in
  `src/channels/slack/thread-delegated-actor.test.ts`.
- `invites list` on a contact turn fails before any Console call.
- `pages share`, `invites create` and `access request` without `--execute`
  MUST exit 3 with `WRITE_REQUIRES_EXECUTE`, a plan showing the page and who
  acts, and no Console call; with `--execute` they POST the documented body.
- `pages unshare` and `invites revoke` MUST have no `--execute` flag and call
  Console at once.
- A Console `403 ACTOR_NOT_LINKED` envelope MUST keep its code and map to
  exit 3 with a message naming `ravi link`.
- `PROJECT_ACCESS_DENIED`, `ORG_ACCESS_DENIED`, `NOT_FOUND`
  (`route_not_found` suggests `--site`) and `CONFLICT` on invites MUST map to
  exit 1 with their own copy.
- `access request` MUST return `approvalUrl` and `approvalNote`;
  `already_allowed` returns the URL and no request.
- `--expires 30d|12h|2w|YYYY-MM-DD|ISO` resolves to an ISO date; past dates
  and more than 365 days fail with exit 2.
