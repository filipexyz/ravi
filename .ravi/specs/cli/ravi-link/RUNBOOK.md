---
id: cli/ravi-link
title: "ravi link runbook"
---

# ravi link / RUNBOOK

## Debug Ambient Failure

```bash
ravi whoami --json
ravi context whoami --json
ravi link --json
```

Check:

- `whoami` has user id, organization id, installation id. If not, `ravi login`.
- `context whoami` metadata `actorPrincipal` is `contact:<id>`. If not, run
  from the contact's turn — do not add flags.
- JSON errors keep `AUTH_REQUIRED`, `CONTACT_REQUIRED`, or
  `ACTOR_BINDING_CONFLICT` without token material.

## Debug Cache / Turn Metadata

After a successful link, `~/.ravi/cloud-auth/bindings/<contactId>.json` should
exist with mode `0600` and no access/refresh tokens. The next turn for that
contact should show `consoleUserId` / `consoleOrgId` in context metadata.

## Console Contract Not Merged

If `PUT /api/cli/actor-bindings` is 404, the sibling Console PR is not
deployed. CLI unit tests still cover storage, ambient errors, and the
negotiated client paths. Do not invent a local-only binding as a substitute.

## Unlink

```bash
ravi unlink --json
```

Expected: Console `DELETE /api/cli/actor-bindings`, local cache removed,
context metadata `consoleUserId` cleared when a context is present.
