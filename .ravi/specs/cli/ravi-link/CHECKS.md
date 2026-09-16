---
id: cli/ravi-link
title: "ravi link checks"
---

# ravi link / CHECKS

## Static Checks

- `ravi link --help` and `ravi unlink --help` MUST expose `--json` and MUST
  NOT expose `--contact`, `--user`, `--org`, or `--endpoint`.
- CLI code MUST NOT persist provider OAuth tokens in `~/.ravi/cloud-auth`.
- Actor-binding cache files MUST contain IDs + TTL only.
- `resolveConnectorCloudCredentials({ requireBoundUser: true })` MUST refuse
  operator JWT fallback.
- The HTTP client MUST call `POST /api/cli/link`, `GET /api/cli/link`, and
  `POST /api/cli/link/unlink`. It MUST NOT call `/api/cli/actor-bindings`.

## Ambient Success

With a stored `ravi login` session and `RAVI_CONTEXT_KEY` pointing at a
turn-runtime whose `actorPrincipal` is `contact:<id>`:

```bash
ravi link --json
```

- The CLI MUST call Console `POST /api/cli/link` with `contactId`,
  `organizationId`, `installationId`, and `platformIdentities` when present.
- JSON MUST include `binding.consoleUserId` and `local.actorPrincipal`.
- The local cache MUST resolve the binding after success.
- Turn metadata MUST be able to carry `consoleUserId`.

## Missing Login

No cloud-auth session:

```bash
ravi link --json
```

- The command MUST fail with `AUTH_REQUIRED`.
- The suggested action MUST be `ravi login`.

## Missing Contact

Cloud session present, no resolved `contact:<id>` in context:

```bash
ravi link --json
```

- The command MUST fail with `CONTACT_REQUIRED`.
- The message MUST tell the operator to run inside a turn/session with a
  contact and MUST NOT suggest a contact flag.

## Conflict

- Console `CONFLICT` MUST map to CLI `ACTOR_BINDING_CONFLICT` for a
  different user and MUST NOT overwrite the local cache.
- A same-user upsert (`created: false`) MUST succeed with `idempotent: true`.

## Error mapping

- Console `NOT_MEMBER` MUST map to `ORG_ACCESS_DENIED`.
- Console `INSTALLATION_ORG_MISMATCH` MUST map to `ORG_ACCESS_DENIED`.
- Console `CONTACT_REQUIRED` MUST stay `CONTACT_REQUIRED`.

## Validation

- `bun test src/cli/commands/link.test.ts` SHOULD pass after any change to
  the ambient link command.
- `bun test src/cloud-auth/client.test.ts` SHOULD prove the `/api/cli/link`
  paths and Console error aliases.
- `bun test src/cloud-auth/storage.test.ts` SHOULD pass after any change to
  the multi-user store.
- `bun test src/cloud-auth/connector-auth.test.ts` SHOULD prove
  `requireBoundUser` refuses operator JWT fallback.
