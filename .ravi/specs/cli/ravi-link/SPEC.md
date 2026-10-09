---
id: cli/ravi-link
title: "ravi link: link the message author to their Console account"
kind: capability
domain: cli
capability: ravi-link
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/cli/commands/identity.ts
  - src/cli/index.ts
  - src/cloud-auth/link-identity.ts
  - src/cloud-auth/actor-bindings.ts
  - src/cloud-auth/client.ts
  - src/cloud-auth/installation-key.ts
  - src/cloud-auth/storage.ts
  - src/identity-link/link-service.ts
  - src/identity-link/link-dm.ts
  - src/identity-link/link-watcher.ts
  - src/identity-link/link-requests-db.ts
  - src/cli/remote-gateway.ts
tags:
  - cli
  - auth
  - console
  - identity
---

# ravi link

## Intent

`ravi link` links the **author of the current chat message** to **their own**
Ravi Console account. The person proves who they are by approving in the
browser with their Console login; the daemon's `ravi login` session is only
the transport. `ravi unlink` removes that person's link on this installation.

The Console owns the contract (`.ravi/specs/console/ravi-link` in
ravi-console). This side asks, delivers the private link, records where to
confirm and caches ids. It does not decide who may link whom.

## Commands

```bash
ravi link            # alias of ravi identity link
ravi unlink          # alias of ravi identity unlink
ravi identity link --json
ravi identity unlink --json
```

- The only flag is `--json`. There MUST NOT be a flag that names a contact,
  user, organization, installation or endpoint.
- Both run in the daemon: the CLI forwards them over the gateway with the
  turn's context key. Without a chat turn they fail `CONTACT_REQUIRED`.
- Neither carries `--execute`: the effect needs the person's approval in the
  browser (link) or only reduces access (unlink).
- The `identity` command group is in the bootstrap baseline, so every agent can
  run it for the person it is talking to.

## Who is linked

The requester is resolved only from the turn's runtime context
(`resolveLinkRequester`). It MUST fail closed with `CONTACT_REQUIRED` and
`details.reason`:

| reason | when |
| --- | --- |
| `no_context` | no runtime context (plain CLI, no turn) |
| `actor_not_human` | `actorPrincipal` is an agent or automation |
| `missing_contact` | `actorPrincipal` is not `contact:<id>`, `actorResolution` is not `resolved`, `actor.actorType` is not `contact`, or `actor.contactId` names another contact |

There is no fallback to other metadata fields, and `ravi link` never creates
contacts. In a channel or thread it acts for the message author only, never
for the channel.

## Flow

1. Resolve the requester and the private route (below). An unsupported
   channel fails `LINK_DM_UNSUPPORTED` before any Console call.
2. With the daemon's Console session (`AUTH_REQUIRED` without one), call
   `POST /api/cli/link/requests` with `contactId`, `platformIdentities`,
   `requester.displayName` and, when known, `expectedEmail`.
3. `already_linked`: refresh the local cache, set `consoleUserId` /
   `consoleOrgId` on the context, answer `already_linked`. No message, no new
   state.
4. `pending`: send the approval URL privately to the author. Record the
   request locally (`cloud_link_requests`: ids, origin chat, private chat,
   expiry; never the URL or token) and answer `dm_sent` with `expiresAt`.
5. If the private message fails: cancel the Console request
   (`DELETE /api/cli/link/requests/:id`), record nothing, fail
   `LINK_DM_FAILED`.
6. The daemon's `LinkRequestWatcher` polls pending requests
   (`GET /api/cli/link/requests/:id`, every 3 s while any is pending, 15 s
   otherwise):
   - `approved`: cache the binding, then confirm in the private chat and in
     the chat where the person asked (in the Slack thread, or under the
     top-level message).
   - `denied` / `expired`: tell the person privately.
   - `cancelled`, or unknown to the Console: close locally without a message.
   Each transition is a conditional update from `pending`, so a confirmation
   goes out once even when several daemons share the database.
7. Every 10 minutes the watcher re-resolves cached bindings of the active
   installation (`GET /api/cli/link?contactId=`), drops revoked ones and
   refreshes live ones, and prunes finished local requests after 7 days.

Repeating `ravi link` while a request is pending sends a fresh link; the
Console cancels the previous one.

## Private route

Derived from the turn actor only:

- **Slack** (native adapter): `chat.postMessage` to the author's user id
  (`U…`/`W…`), which lands in the app DM, with `unfurl_links` and
  `unfurl_media` off so no unfurler fetches the single-use URL. The link is
  shown as a labelled markdown link.
- **WhatsApp** (Omni): the same chat when the turn is already a direct chat,
  otherwise the sender's own number. Never a group.
- Anything else: `LINK_DM_UNSUPPORTED`.

The URL goes straight from the daemon to the platform: never through
`ravi.outbound.deliver`, NATS, logs, agent output, the transcript, stdout or
JSON. On Slack the author's profile email (`users.info`, needs
`users:read.email`) is sent as `expectedEmail` when available; the Console
refuses an approver whose verified email does not match.

## Output

```ts
{ success: true, status: "already_linked", linked: true }
{ success: true, status: "dm_sent", linked: false, expiresAt: string }
{ success: true, status: "unlinked" | "not_linked", linked: false }
```

Outputs and errors MUST NOT contain the approval URL, token, emails, Console
user ids, installation ids or platform ids. Over the gateway, failures of
`identity link` / `identity unlink` keep the local message and suggested
action for known cloud codes instead of "Remote command failed.".

## Installation identity

- `ravi login` sends `installation.machineFingerprint` from a random 32-byte
  key at `<stateDir>/cloud-auth/installation-key` (mode 0600, survives
  logout), so a re-login reuses the same Console installation.
- Exchange, refresh and `/api/cli/me` responses carry the Console's
  `localInstallation.id`. The CLI stores it as `installationId` and repairs
  credentials saved with a local random id on the next `/me`.
- Link calls never send `installationId`; the Console pins them to the CLI
  session's installation.

## Errors

| code | meaning |
| --- | --- |
| `CONTACT_REQUIRED` | the author is not a resolved person (see reasons) |
| `LINK_DM_UNSUPPORTED` | no private route to the author on this channel |
| `LINK_DM_FAILED` | the private message failed; the request was cancelled |
| `LINK_REQUESTS_UNAVAILABLE` | the Console has no `/api/cli/link/requests` (too old) |
| `LINK_APPROVAL_REQUIRED` | the Console refused the old direct link |
| `LOCAL_INSTALLATION_MISSING` | the session has no Console installation; run `ravi login` again |
| `INSTALLATION_MISMATCH` | a request named another installation |
| `ACTOR_BINDING_CONFLICT` | the contact is linked to someone else (Console `CONFLICT`) |
| `ORG_ACCESS_DENIED` | Console `NOT_MEMBER` / `INSTALLATION_ORG_MISMATCH` |
| `AUTH_REQUIRED` | no `ravi login` on the daemon host |

## Pages and the bridge

`resolveCachedContactForConsoleUser({ consoleUserId, orgId, installationId })`
maps a verified Console user (the `sub` of a Pages viewer assertion) to the
contact linked on this installation, and returns null unless exactly one
cached binding matches. Opening that person's session from a Pages assertion
is later scope.

## Acceptance Criteria

- In a channel or thread, `ravi link` sends the private link to the author only.
- After approval the binding is cached and both chats get a confirmation.
- Repeating the command reports `already_linked` without new state.
- Expired, denied or reused links and a different approver fail on the Console
  with a safe reason; the person is told privately about expiry and denial.
- A failed private message returns `LINK_DM_FAILED` without ids or tokens.
- `ravi unlink` and the Console `/link` page revoke; the watcher drops revoked
  bindings from the cache.
