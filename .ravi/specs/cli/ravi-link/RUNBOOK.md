---
id: cli/ravi-link
title: "ravi link runbook"
---

# ravi link / RUNBOOK

## The command fails

```bash
ravi whoami --json            # on the daemon host: user, organization, installation
ravi context whoami --json    # inside the turn: actorPrincipal, actorResolution
```

- `AUTH_REQUIRED` / `LOCAL_INSTALLATION_MISSING`: run `ravi login` on the
  daemon host. A first login after this change creates a new Console
  installation, so links made before it must be redone.
- `CONTACT_REQUIRED`: read `details.reason`. `missing_contact` means the
  author is not a known contact (for Slack, check contact intake for the
  channel); `actor_not_human` means a cron, trigger or agent started the turn.
- `LINK_DM_UNSUPPORTED`: the channel has no private route (Slack must use the
  native adapter; WhatsApp must go through Omni).
- `LINK_DM_FAILED`: the Slack app cannot DM the author (app not installed for
  them, DMs disabled) or Omni rejected the send. Nothing was linked.
- `LINK_REQUESTS_UNAVAILABLE`: the Console is older than the link-request
  endpoints.

## The person approved but nothing was confirmed

- The confirmation comes from the daemon's `LinkRequestWatcher`. Check the
  daemon logs for `identity:link-watcher`.
- `cloud_link_requests` in `ravi.db` shows the local status. A row stuck in
  `pending` under an installation other than the current session's is
  abandoned an hour after it expires.

## Revoking

- From the person's chat: `ravi unlink`.
- From the browser: the person opens `<console>/link` and revokes.
- The watcher re-checks cached bindings every 10 minutes and drops revoked
  ones.
