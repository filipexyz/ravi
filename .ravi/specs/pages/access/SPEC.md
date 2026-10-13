---
id: pages/access
title: "Share Pages, invite and ask for access from the CLI"
kind: capability
domain: pages
capabilities:
  - access
tags:
  - pages
  - agents
  - console
  - access
applies_to:
  - src/access/actor.ts
  - src/access/client.ts
  - src/access/command-support.ts
  - src/cli/commands/pages.ts
  - src/cli/commands/invites.ts
  - src/cli/commands/access.ts
  - src/cloud-auth/errors.ts
  - src/cli/cloud-error-contract.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Share Pages, invite and ask for access from the CLI

## Intent

Agents give one person access to a private Page, invite people into the
Console organization and ask a Page's managers for access, through the
`ravi login` session. Console owns who may do each of these (Console spec
`console/access`, "CLI Contract"); this side owns transport, input checks,
the write brake and who the turn says is acting.

## Commands

| Command | Console route | Brake |
| --- | --- | --- |
| `ravi pages share <url> --with <email> [--site] [--expires] [--reason]` | `POST /api/cli/access/pages/share` | `--execute` |
| `ravi pages unshare <url> --with <email> [--site]` or `--grant <id>` | `POST /api/cli/access/pages/unshare` | none |
| `ravi pages access <url>` | `POST /api/cli/access/pages/access` | read |
| `ravi invites create --email <e> [--role] [--reason]` | `POST /api/cli/access/invites/create` | `--execute` |
| `ravi invites list` | `GET /api/cli/access/invites` | read |
| `ravi invites revoke <id>` | `POST /api/cli/access/invites/revoke` | none |
| `ravi access request <url> [--message]` | `POST /api/cli/access/requests/create` | `--execute` |
| `ravi access status <id>` | `GET /api/cli/access/requests/<id>` | read |

## Invariants

1. Who acts MUST come from `resolveConnectorTurn`. The operator's own turn
   (terminal, the owner's own chat, the owner's own relay, routines the owner
   owns; also the owner refused only for where they asked) sends no `actor`.
   A resolved contact who is not the owner sends `actor: { contactId }`. Any
   other turn MUST be refused locally with `ACTOR_UNKNOWN` (exit 3) before any
   Console call; it MUST NOT fall back to the operator.
2. `invites list` (a GET with no actor) MUST run only when the operator acts.
3. `access request` MUST send `agent: { id, name? }` when the turn names an
   agent.
4. `pages share`, `invites create` and `access request` MUST dry-run without
   `--execute`: print the plan (page, target, who acts) and exit 3 before any
   Console call. `pages unshare` and `invites revoke` only reduce access and
   MUST apply immediately.
5. Console `ACTOR_NOT_LINKED` MUST surface as `ACTOR_NOT_LINKED`, exit 3, and
   tell the agent to run `ravi link` in that person's chat.
6. `access request` and `access status` MUST print the approval link and say
   that anyone can forward it and only the page's managers approve. The link
   is Console's `request.url` when it is https, else
   `<console>/access/requests/<id>`.
7. `--expires` MUST resolve locally to an ISO date in the future and at most
   365 days out; `--role` MUST be one of the Console `organization_role`
   values; emails are lowercased.
8. The commands MUST declare `@CommandAccess` resources `pages.access`,
   `invites` and `access.requests`, none of which is in the bootstrap floor.
