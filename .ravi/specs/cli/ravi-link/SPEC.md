---
id: cli/ravi-link
title: "ravi link ambient identity binding"
kind: capability
domain: cli
capability: ravi-link
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/cli/commands/link.ts
  - src/cloud-auth/link-identity.ts
  - src/cloud-auth/actor-bindings.ts
  - src/cloud-auth/connector-auth.ts
  - src/cloud-auth/client.ts
  - src/runtime/runtime-request-context.ts
tags:
  - cli
  - auth
  - console
  - identity
---

# ravi link

## Intent

`ravi link` binds the **current human contact** to the **current Console user**.
`ravi unlink` removes that ambient binding. Both commands take **no identity
flags**. Agents use `--json`.

This is not `ravi instances` (channel accounts) and not SSO via
`RAVI_ADMIN_TOKEN`.

## Commands

```bash
ravi link
ravi unlink
ravi link --json
ravi unlink --json
```

`--help` MUST expose `--json` and MUST NOT expose `--contact`, `--user`,
`--org`, `--endpoint`, or any other identity-passing flag.

## Ambient resolution (no flags)

**Console identity** comes from the current cloud-auth session (`ravi login`):

- `consoleUserId`
- `orgId`
- `installationId`

**Local identity** comes from ambient `RAVI_CONTEXT_KEY` / turn-runtime (or
cli-runtime derived from it):

- `actorPrincipal` MUST be `contact:<id>` (a resolved human)
- platform identity from turn metadata MUST be included when present
  (`channel`, `accountId`, `platformIdentityId`, `platformUserId`)

Hard errors:

- No cloud session → `AUTH_REQUIRED`: run `ravi login` first
- No resolved contact in context → `CONTACT_REQUIRED`: must run inside a
  turn/session with a contact. Do **not** add flags to pass a contact.

## Organization match

If installation enrollment split exists, the cloud session org MUST match the
installation's enrolled org.

That split is **not ready**. This capability REQUIRES the cloud session org
and documents the follow-up: match `installation.enrolledOrgId` when Console
exposes it.

## Console API contract

The CLI calls the merged Console surface from ravi-console#18. Do not invent a
parallel path such as `/api/cli/actor-bindings`.

```
POST   /api/cli/link
GET    /api/cli/link?contactId=… or ?consoleUserId=…
DELETE /api/cli/link
POST   /api/cli/link/unlink
```

`POST /api/cli/link` body (camelCase; Console also accepts snake_case aliases).
The schema is strict — do not send `actorPrincipal` or `orgId`:

```ts
{
  contactId: string
  installationId?: string
  organizationId?: string
  consoleUserId?: string   // v1 must equal the caller
  platformIdentities?: {
    channel?: string
    accountId?: string
    platformUserId?: string
    platformIdentityId?: string
  }
}
```

Success:

```ts
{
  version: 1
  created: boolean
  binding: {
    id: string
    contactId: string
    consoleUserId: string
    organizationId: string
    installationId: string
    platformIdentities?: object
    status: "active" | "revoked"
  }
}
```

`created` is false when the active row already belongs to the same Console
user (idempotent upsert). The CLI maps that to `idempotent: true`.

Console error codes map to existing CLI codes:

| Console | CLI |
| --- | --- |
| `CONTACT_REQUIRED` | `CONTACT_REQUIRED` |
| `CONFLICT` | `ACTOR_BINDING_CONFLICT` |
| `NOT_MEMBER` | `ORG_ACCESS_DENIED` |
| `INSTALLATION_ORG_MISMATCH` | `ORG_ACCESS_DENIED` |
| `AUTH_REQUIRED` / `AUTH_EXPIRED` | same |
| `INSTALLATION_REVOKED` | `INSTALLATION_REVOKED` |

If the existing binding is the same Console user, `ravi link` MUST succeed
idempotently (`created: false`, or a same-user `CONFLICT` resolved locally).

## Local cache

After a successful link, the CLI MUST write a TTL'd local cache of **IDs
only** so later ambient resolution can read the binding without another
round trip. Console remains the source of truth.

Cache path: `~/.ravi/cloud-auth/bindings/<contactId>.json` mode `0600`.

On unlink, the cache entry MUST be deleted.

## Turn-runtime

When a contact has a binding, turn-runtime MUST set `consoleUserId` and
`consoleOrgId` on context metadata so later connector work can use that
user's Console session.

## Credentials boundary

- `ravi link` stores an **identity binding** via Console (IDs only).
- It MUST NOT store Gmail/Slack/provider OAuth tokens locally.
- Multi-user Console session JWTs live in `cli/cloud-auth` under
  `users/<consoleUserId>/`.
- User-scoped connector tools MUST NOT fall back to the operator JWT. Use
  `resolveConnectorCloudCredentials({ requireBoundUser: true })`. The full
  user-scoped Worker vault is a follow-up.

## Acceptance Criteria

- Ambient success with login + contact context links and caches the binding.
- Missing login → `AUTH_REQUIRED`.
- Missing contact → `CONTACT_REQUIRED`.
- Same-user re-link is idempotent.
- Different-user conflict surfaces `ACTOR_BINDING_CONFLICT`.
- `--json` redacts tokens.
- No identity flags exist on `ravi link` / `ravi unlink`.
