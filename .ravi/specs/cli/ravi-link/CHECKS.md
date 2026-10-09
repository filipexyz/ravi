---
id: cli/ravi-link
title: "ravi link checks"
---

# ravi link / CHECKS

## Static Checks

- `ravi link --help`, `ravi unlink --help` and `ravi identity link --help`
  MUST expose only `--json`.
- No code path MUST print, log, publish or return the approval URL or token.
  It goes from `createLinkRequest` straight into `LinkMessenger.send`.
- `cloud_link_requests` and the binding cache MUST hold ids and chat
  coordinates only.
- Link calls MUST NOT send `installationId`.
- The client MUST NOT call `POST /api/cli/link` (closed by the Console).

## Requester

- No context, an agent or automation principal, an unresolved actor, or an
  actor whose `contactId` differs from the principal MUST fail
  `CONTACT_REQUIRED` with the matching `details.reason`, before any Console
  call or message.

## Link

- `already_linked` MUST write the cache, update context metadata and send no
  message.
- `pending` MUST send exactly one private message to the author (Slack user
  id, unfurl off) and record the local request with the chat the message
  landed in.
- A failed private message MUST cancel the Console request, record nothing and
  fail `LINK_DM_FAILED` without ids.
- A second `ravi link` while pending MUST leave only the newest local request
  pending.
- Slack outside the native adapter, a non-person Slack sender, a WhatsApp
  group as recipient, and other channels MUST fail `LINK_DM_UNSUPPORTED`.

## Watcher

- `approved` MUST cache the binding and confirm in the private chat and in
  the origin chat once (a Slack top-level message gets a thread reply).
- `denied` and `expired` MUST tell the person privately.
- A request unknown to the Console MUST close as `failed`.
- Requests created under another installation MUST be left alone until an
  hour after they expire.
- Revalidation MUST drop cached bindings the Console no longer reports and
  MUST NOT touch bindings of another installation.
- `approved` with no binding (revoked right after approval) MUST close the
  request without caching or confirming.
- An unlink MUST win over a poll or a revalidation already in flight: the
  watcher claims the request before caching, and revalidation never rewrites
  or deletes an entry whose binding id, Console user or installation changed,
  or that disappeared, during its call.

## Validation

```bash
bun test src/identity-link/ src/cloud-auth/
bun test src/router/router-db.link-requests.test.ts
bun test src/channels/slack/text-send.test.ts
bun test src/cli/remote-gateway.test.ts
```
