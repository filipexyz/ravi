# Share Pages, invite and ask for access from the CLI / RUNBOOK

## Try it

```bash
ravi pages share https://acme-proj.ravi.page/report --with ana@example.com --json   # plan, exit 3
ravi pages share https://acme-proj.ravi.page/report --with ana@example.com --execute --json
ravi pages access https://acme-proj.ravi.page/report --json
ravi pages unshare https://acme-proj.ravi.page/report --with ana@example.com
ravi invites create --email bia@example.com --role developer --execute
ravi access request https://other.ravi.page/x --message "Q3" --execute --json
ravi access status <request-id>
```

## Exit codes

- `3` `WRITE_REQUIRES_EXECUTE`: the brake. Read `plan.actingAs`, then re-run
  with `--execute`.
- `3` `ACTOR_NOT_LINKED`: the person who wrote the message has no `ravi link`
  on this installation. Run `ravi link` from their chat, then retry.
- `3` `ACTOR_UNKNOWN`: the turn could not be attributed (unresolved sender,
  another agent's relay, a routine someone else owns, an ended turn). Run it
  from the terminal or have the person ask in their own chat.
- `1` `PROJECT_ACCESS_DENIED`: the `ravi login` user or the acting person lacks
  the role (share: write on the project; invites: owner or admin).
- `1` `ORG_ACCESS_DENIED`: the page is in another organization; use
  `ravi access request <url>`.
- `1` `NOT_FOUND`: no page, route (`--site` shares the whole site), grant,
  invite or request.
- `2`: a bad URL, email, `--role`, `--expires`, or `unshare` without a target.
