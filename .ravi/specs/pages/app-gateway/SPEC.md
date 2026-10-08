---
id: pages/app-gateway
title: "Pages app gateway (installation side)"
kind: capability
domain: pages
capabilities:
  - app-gateway
tags:
  - pages
  - apps
  - console
  - cli
  - relay
applies_to:
  - src/app-gateway
  - src/pages/app-gateway-targets.ts
  - src/cli/commands/pages.ts
  - src/cli/commands/settings.ts
  - src/cli/commands/agents.ts
  - src/apps/gateway-declaration.ts
  - src/apps/gateway-command.ts
  - src/apps/service.ts
  - src/apps/router.ts
  - src/apps/permissions.ts
  - src/permissions/scope.ts
  - src/permissions/authorization-agent.ts
  - src/mailbox/access.ts
  - src/calendar/access.ts
  - src/router/router-db.ts
  - src/daemon.ts
  - src/plugins/internal/ravi-system/skills/pages/SKILL.md
owners:
  - ravi-dev
status: draft
normative: true
---

# Pages app gateway (installation side)

## Intent

A shipped Pages site can call a read-only operation of a Ravi app that runs on one installation: `POST /_ravi/apps/<appId>/<operationId>` with a short-lived viewer assertion. Console decides who may mint, signs the target grant, and pushes it to the edge. The Pages Worker and the `ExecutorRelay` can only refuse. This installation dials out to the relay, verifies what it receives, applies its own local opt-in, and runs the operation through the App Router.

This spec covers only the local half: the `ravi pages apps targets` CLI, the relay runner, the installation executor, and the App Router and permission changes they need. OSS consumes the public formats. It MUST NOT implement the target registry, mint checks, audience exclusivity, grant or ticket signing, or edge storage. Those stay in Console.

## Console contract

The source of truth is the Console spec tree `.ravi/specs/console/pages/app-gateway/`:

- `SPEC.md`: locked decisions, registry and mint policy (Console only).
- `relay/SPEC.md`: shared constants, target grant and relay ticket formats, frames, close codes, the Installation Executor section, and the errors table.
- `cli/SPEC.md`: the target registry HTTP routes and `POST /api/cli/apps/relay-ticket`.

OSS keeps its own copy of the public constants in `src/app-gateway/constants.ts` and MUST NOT import Console code. When a value here and the Console wire contract disagree, the Console wire contract wins and this spec MUST be updated in the same change.

## Commands

```
ravi pages apps targets list   --site <ref> [--project <ref>] [--console <url>] [--limit <n>] [--offset <n>] [--json]
ravi pages apps targets set    --site <ref> --aud <aud> --app <appId> --op <operationId> [--op …] --origin https://… [--origin …] [--installation <id>] [--project <ref>] [--console <url>] [--json] --execute
ravi pages apps targets remove --site <ref> --aud <aud> [--project <ref>] [--console <url>] [--json] --execute
```

There is no user command for the relay ticket. Only the daemon's relay runner calls that route.

## Invariants

### Targets CLI

1. The group MUST be `pages.apps.targets`. `list` MUST be `kind: read`. `set` and `remove` MUST be `kind: mutate`, `risk: high`, `requiresConfirmation: true`, with `--execute` as the last declared option.
2. `--site` and `--project` MUST resolve exactly as in `ravi pages assertion audiences` (see `pages/assertion-audiences`).
3. `list` MUST `GET /api/cli/projects/:projectRef/pages/:siteRef/app-gateway-targets`, MUST NOT dry-run, and MUST accept `--limit` and `--offset`.
4. `set` MUST validate before the brake: `--aud` in the audience grammar (no spaces, no `*`, not a JWT); `--app` in the app id grammar; `--op` repeatable and comma-separable, 1 to 16 exact operation ids with duplicates removed and order kept; `--origin` with the same https rules and limit (8) as viewer-assertion audiences; `--installation`, when given, a UUID. Any failure is `PAYLOAD_INVALID` (exit 2) before any Console call.
5. `--installation` MUST default to this installation's Console id from `GET /api/cli/me` (`localInstallation.id`). It MUST NOT use the locally generated `credentials.installationId`. When Console does not report one, the `PUT` body MUST omit `installationId` so Console defaults it to the session's installation.
6. Without `--execute`, `set` MUST exit 3 with `WRITE_REQUIRES_EXECUTE` and a plan that names the resolved installation id, before any Console write. When `--installation` is omitted, the dry-run MAY read `GET /api/cli/me` to resolve it; that read is the only Console call a `set` dry-run makes. `remove` without `--execute` MUST exit 3 before credentials and Console.
7. `set --execute` MUST `PUT` the targets path with `{ audience, installationId?, appId, operations, origins }`, at most 8192 bytes. `remove --execute` MUST `DELETE` the targets path with the exact audience in the `aud` query.
8. Output MUST whitelist the target fields of the Console `cli/SPEC.md` Target shape. Grants, tickets, tokens, and any JWT-shaped value MUST be dropped.

### Enablement

9. The relay runner MUST NOT dial out unless all of these hold, and while parked it MUST re-check every 60 s:
   - env `RAVI_APP_GATEWAY_ENABLED=1` exactly; any other value or unset means the runner does not start;
   - the stored CLI session carries the scope `console.apps.relay`; when it is missing, the runner logs once that `ravi login` is needed;
   - `apps.gateway.allowed_operations` is non-empty and valid;
   - this process holds the SQLite relay lease `console_executor_relay_locks` for `(consoleUrl, installationId)`: 60 s TTL, renewed every 20 s, random owner id.
10. The runner MUST be per-daemon, not leader-gated, and MUST be started and stopped from `src/daemon.ts` next to the inbox and sync runners. Losing the lease or emptying the allowlist MUST close every socket and park.

### Local settings

11. `apps.gateway.allowed_operations` holds comma-separated exact `<appId>:<operationId>` pairs. It MUST refuse `*` and app-only entries at `ravi settings set`. At runtime an unparsable value counts as empty.
12. `apps.gateway.require_link` is `true` or `false` (default `false`). Only the exact value `true` requires a Ravi Link contact.
13. `ravi settings set` and `ravi settings delete` on any `apps.gateway.` key MUST require superadmin (`admin` on `system:*`) or the local operator, through the same check as `permissions.*`. An agent session that holds only the `settings` group MUST be refused.
14. The executor MUST read both settings on every invoke, with no cache.

### Relay connection

15. Tickets MUST come from `POST /api/cli/apps/relay-ticket` with the stored credentials, refreshing once on `AUTH_EXPIRED` through `refreshCredentialsForStore`. Token refresh MUST NOT be re-implemented.
16. The runner MUST bind invokes to the ticket response's `installationId` and `organizationId`, never to the local `credentials.installationId`. It MUST accept `relayUrl` only with `wss:`; `ws:` only for `localhost`, `127.0.0.1`, `::1`, or with `RAVI_ALLOW_INSECURE_CONSOLE_URL=true`.
17. The socket MUST carry the ticket only in `Authorization` and MUST offer `ravi.executor-relay.v1`. The runner MUST treat a connection as up only after `relay.ready` whose `installationId` matches the ticket response.
18. At `renewAt` the runner MUST open a second socket with a new ticket and keep answering each invoke on the socket it arrived on.
19. Close codes:
    - 4000 on a socket that is older than a socket this runner opened and the relay accepted (upgrade completed) is self-replacement. When no socket of ours is live, the runner MUST reconnect with the normal backoff and MUST NOT park.
    - 4000 on the newest socket the relay accepted means another process holds the installation: back off 60 s and log once.
    - 4001 MUST fetch a ticket and reconnect at once. 1000, 4002, 4003, and drops MUST reconnect with backoff.
20. Reconnect backoff MUST be 1 s doubling to 60 s with ±20 % jitter, reset once a connection that received `relay.ready` has lasted 60 s. Ticket errors: `AUTH_REQUIRED`, `INSTALLATION_REVOKED`, `CREDENTIALS_INVALID` park 60 s; `PROJECT_ACCESS_DENIED` parks 5 min; `RATE_LIMITED` honors `retryAfterMs`; anything else backs off 5 s to 5 min.
21. The runner MUST send `{"type":"ping"}` every ping interval and terminate the socket when no pong arrives within 10 s. Binary frames, unknown types, extra fields, and frames above the cap MUST close with 4003.

### Executor

22. The executor MUST run the steps of the Console `relay/SPEC.md` "Verify, in order" table in that order and answer with the code that table names. Only invokes that passed frame shape, grant, and assertion verification enter the seen-`requestId` set (120 s, at most 10000 ids; when full, refuse with `app_gateway_rate_limited`).
23. Grant and assertion verification MUST use `jose` on the Console JWKS (`pagesAssertionJwksUrl(consoleUrl)`) with the JWKS client rules: refresh after 300 s, unknown-kid refetch at most every 30 s, 5 s fetch timeout, stale-if-error at most 3600 s, then `app_gateway_unavailable`. After a failed refresh the still-usable stale set is served without another refresh attempt for 30 s (an unknown kid still refetches within its own 30 s limit). A key MUST verify only its own token type (`alg`, `typ`, kid prefix, pinned `iss`).
24. The grant's `installation` and `raviOrgId` MUST equal this installation's Console id and organization from the ticket response.
25. Concurrency MUST stay below 8, and a slot MUST be held until the child process group has exited.
26. `apps.error` MUST carry only executor codes from the Console errors table. `stdout`, `stderr`, `command`, context ids, and permission-provider details MUST NOT be forwarded.

### Manifest gateway declaration

27. An operation is exposed only when it is a key of the manifest's `operations`, declares `"mutating": false` explicitly, carries a valid `gateway` declaration, uses interface `builtin` or `cli`, and is not the permission-provider operation.
28. `gateway.args` is `"none"` or `{ options?, flags?, positional? }`: up to 16 long options that each take one value, up to 16 long flags, disjoint, names matching `^--[a-z0-9][a-z0-9-]*$`, never `--execute` or `--`; `positional` 0 to 8 (default 0). `ravi apps check` MUST refuse an invalid declaration and MUST warn when `gateway` is set without `"mutating": false`.
29. When `gateway.args` is not `"none"`, a `cli` operation's command MUST fix what runs before the viewer args start, because positional values are free text. `ravi apps check` MUST refuse, and the executor MUST treat as not exposed, a command where:
    - the executable is `ravi`, and the tokens after it, up to the first option or `{args}`, do not start with one full CLI registry command (group path, then command; group and command aliases count; root commands registered by hand in `src/cli/index.ts`, such as `doctor` or `whoami`, never match); or that command is a dispatcher (`apps run`, `apps import-cli`, `jobs run`, `commands run`, `tools invoke`, `tools test`); or the registry marks it `mutate`; or it also has subcommands (`crm account` and `crm account create`) and no fixed word follows its name;
    - the executable is any other program, and it is a program runner (`env`, `xargs`, `sudo`, `nohup`, `timeout`, `npx`, `bunx`, `ssh`, `open`, and the rest of `GATEWAY_PROGRAM_RUNNERS`); or no word (a token not starting with `-`) follows it before `{args}`; or the last such word is `run`, `exec`, `x`, `dlx`, or `eval`; or a word follows `{args}`;
    - for any executable, `positional` is above 0 and the token right before the viewer args is an option.

    The installation knows only the Ravi CLI grammar, so for other programs the app author MUST still point the command at its final subcommand.
30. The executor MUST read `body.args` left to right against the declaration. Undeclared options, short options, `--name=value`, `--`, a repeated option or flag, a missing value, a value that starts with `-`, and positionals above the limit MUST be `payload_invalid` with nothing spawned. Accepted args MUST pass unchanged and in order.

### App Router

31. `runAppOperation` MUST accept `exactOperation`. With it, the operation MUST be an exact manifest key; aliases, virtual builtins (`help`, `show`, `check`), and joining leading args into a longer id MUST be off.
32. `runAppOperation` MUST accept `timeoutMs`, `maxOutputBytes`, and `signal`. For the `cli` interface the child MUST run in its own process group, and on timeout, abort, or stdout or stderr above `maxOutputBytes` the router MUST kill the whole group (SIGTERM, then SIGKILL after 2 s) and return `APP_OPERATION_TIMEOUT` or `APP_OUTPUT_TOO_LARGE`. Callers that pass none of these MUST keep today's behavior.
33. The executor MUST call it with `json: true`, `execute: false`, `exactOperation: true`, `timeoutMs: 28000`, `maxOutputBytes: 1179648`, the invoke's abort signal, and the daemon environment without `RAVI_CONTEXT_KEY`.

### Local authority

34. Each invoke MUST run under a parent runtime context of kind `pages-app-gateway` with no `agentId`, capabilities `use:app:<appId>` plus the manifest `context.allow`, TTL 35 s, and metadata `actorPrincipal`, `surfacePrincipal`, `raviUserId`, `raviOrgId`, `siteId`, `projectId`, `audience`, `appGatewayTargetId`, `requestId`, `source: "pages-app-gateway"`. It MUST NOT set `consoleUserId`, `consoleOrgId`, or `authorityMode`. The context MUST be revoked in `finally`, after the child exits.
35. `actorPrincipal` MUST be `contact:<contactId>` only when exactly one unexpired cached actor binding matches the viewer, org, and (when non-empty) installation; otherwise `ravi_user:<raviUserId>`. Ravi Link MUST be read only from the local cache during an invoke. `surfacePrincipal` MUST be `pages_site:<siteId>`.
36. A caller MUST take the local-operator fallback only when it has neither an `agentId` nor a runtime context record (`isLocalOperatorScope`). With a context record present, `canAccessApp`, the `src/permissions/scope.ts` checks (including `isScopeEnforced` and `filterAccessibleSessions`), `src/mailbox/access.ts`, and `src/calendar/access.ts` MUST authorize from the record's capabilities only. This covers the app child, any `ravi` command it runs, SDK-gateway calls with its `rctx_*` key, and orphaned contexts whose agent was deleted.
37. `pages-app-gateway` is an in-process audit label, not an agent. It MUST NOT become a permission subject or fill a context record's `agentId`, and `ravi agents create` MUST refuse it.

### Logging

38. The executor MUST log one line per invoke with `requestId`, `appId`, `operation`, `siteId` (once known), outcome code, and duration. The runner and the executor MUST NOT log the ticket, assertion, grant, `args`, `body`, result, or `rctx_*` keys.

## Write classification

| op | class | brake |
|---|---|---|
| apps targets list | reads the site's gateway targets, active and revoked | none |
| apps targets set | lets this site's pages invoke listed operations on one installation for one aud | dry-run + `--execute` (dry-run MAY read `GET /api/cli/me`) |
| apps targets remove | revokes one target; the aud stays reserved for the gateway | dry-run + `--execute` |
| `settings set/delete apps.gateway.*` | widens or narrows what org Pages viewers may run locally | superadmin or local operator only |

## Official error cases

| case | code | exit |
|---|---|---|
| `set` or `remove` without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| malformed `--aud`, `--app`, `--op`, `--origin`, or `--installation`; more than 16 ops or 8 origins | `PAYLOAD_INVALID` | 2 |
| Console 409: the aud is an active viewer-assertion audience on this site | `APP_GATEWAY_AUDIENCE_CONFLICT` | 2 |
| Console 403 `INSTALLATION_ORG_MISMATCH` (installation missing, revoked, other org, owner not a member, or caller cannot manage it) | `INSTALLATION_ORG_MISMATCH` | 1 |
| Console 404 on `remove` (aud not registered on this site) | `TARGET_NOT_FOUND` | 2 |
| Console 503 (grant keys or edge store unavailable, repair marker set) | `SERVER_UNAVAILABLE` (CloudAuthError funnel) | 1 |
| missing CLI session | `AUTH_REQUIRED` (CloudAuthError funnel) | 1 |

## Validation

- `bun test --timeout 20000 src/app-gateway/ src/apps/gateway-declaration.test.ts src/apps/gateway-command.test.ts src/apps/permissions.test.ts src/mailbox/access.test.ts src/calendar/access.test.ts`
- `bun test src/apps/router.test.ts src/permissions/scope.test.ts src/cli/commands/pages.test.ts src/cli/commands/settings.test.ts src/cli/commands/agents.test.ts`
- `make quality`

## Known Failure Modes

- Treating a 4000 close as "another process" only because no socket is live parks the installation for 60 s after its own renewal socket died first.
- Taking the local-operator fallback whenever `agentId` is missing hands operator authority to a gateway context, its app child, and orphaned contexts.
- Binding grants to the locally generated `credentials.installationId` instead of the ticket's Console installation id refuses every invoke.
- Caching `apps.gateway.allowed_operations` keeps an operation exposed after the operator removed it.
- Trusting `"mutating": false` without a `gateway` declaration lets a viewer pass `--execute` or select another subcommand through argv.
- Checking only arg names lets one declared operation become a door to any command: with `ravi {args}`, `bash -c {args}`, or `npm run {args}`, a positional value picks what runs.
- Matching `ravi crm account` as a full command lets a viewer positional `create` run `ravi crm account create`: Commander reads the first operand after a command that also has subcommands as a subcommand name.
