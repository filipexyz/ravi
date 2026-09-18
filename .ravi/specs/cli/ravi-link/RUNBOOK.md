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

## Console Contract

Console owns `POST/GET/DELETE /api/cli/link` and `POST /api/cli/link/unlink`
(ravi-console#18). A 404 on those paths is a deploy/version mismatch, not a
reason to invent `/api/cli/actor-bindings`.

## Unlink

```bash
ravi unlink --json
```

Expected: Console `POST /api/cli/link/unlink`, local cache removed,
context metadata `consoleUserId` cleared when a context is present.
