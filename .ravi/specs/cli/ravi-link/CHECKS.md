---
id: cli/ravi-link
title: "ravi link checks"
---

# ravi link / CHECKS

## Static Checks

- `ravi link --help` and `ravi unlink --help` expose `--json` only as the
  identity-adjacent option. No `--contact`, `--user`, `--org`, `--endpoint`.
- CLI code does not persist provider OAuth tokens in `~/.ravi/cloud-auth`.
- Actor-binding cache files are IDs + TTL only.
- `resolveConnectorCloudCredentials({ requireBoundUser: true })` refuses
  operator JWT fallback.

## Ambient Success

With a stored `ravi login` session and `RAVI_CONTEXT_KEY` pointing at a
turn-runtime whose `actorPrincipal` is `contact:<id>`:

```bash
ravi link --json
```

Expected:

- Console `POST /api/cli/link` is called with contact, organizationId,
  installation, and `platformIdentities` when present;
- JSON includes `binding.consoleUserId` and `local.actorPrincipal`;
- local cache can resolve the binding;
- turn metadata can carry `consoleUserId`.

## Missing Login

No cloud-auth session:

```bash
ravi link --json
```

Expected: `AUTH_REQUIRED`, suggested action is `ravi login`.

## Missing Contact

Cloud session present, no resolved `contact:<id>` in context:

```bash
ravi link --json
```

Expected: `CONTACT_REQUIRED`. Message MUST tell the operator to run inside a
turn/session with a contact and MUST NOT suggest a contact flag.

## Conflict

Console returns `CONFLICT` (CLI `ACTOR_BINDING_CONFLICT`) for a different user:

Expected: error code preserved, no cache overwrite.

Same Console user already bound:

Expected: success, `idempotent: true`.

## Validation

- `bun test src/cli/commands/link.test.ts`
- `bun test src/cloud-auth/storage.test.ts`
- `bun test src/cloud-auth/connector-auth.test.ts`
- `bun test src/cli/root-version.test.ts`
