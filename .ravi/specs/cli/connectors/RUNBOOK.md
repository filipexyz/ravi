# Connectors agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/connectors --mode rules --json`.
2. Reproduce with `--json`; verify the stable CloudAuthError code is preserved
   under the global exit map.
3. `WRITE_REQUIRES_EXECUTE` (exit 3): read `error.plan`, confirm the revoke is
   intended, re-run with `--execute` (or `--yes`, the legacy equivalent).
4. `CONNECTOR_GROUP_BLOCKED` (exit 3): the turn is in a group chat. Say
   `error.chatLine` in the group and continue in the owner's direct chat. Do
   not retry with other flags.
5. `CONNECTOR_SPEAKER_NOT_OWNER` (exit 3): the turn is not the owner's. Say
   `error.chatLine` to the person who asked. If the owner is the one asking
   from their own chat, they must run `ravi link` there once. If the turn
   should be the operator's, inspect it with
   `ravi sessions trace <session> --explain` and check `actorPrincipal`,
   `actorResolution`, `consoleUserId` and `agentIdentityCompartment` of the
   turn context; a cron needs `ravi cron show <id>` → "Runs as: operator".
6. `CONNECTOR_REAUTH_REQUIRED` (exit 1): send `error.chatLine` to the owner
   privately (`error.reconnectLink` is the whole link), or run
   `ravi connectors connect google --reconnect <id>`.
7. `CONNECTOR_CONNECTION_REQUIRED` (exit 1): `ravi connectors connect google`.
8. `CONNECTOR_APPROVAL_REQUIRED` / `_PENDING` (exit 3): send `error.chatLine`
   (the `approvalLink`) to the owner privately, never in a group; after they
   approve, run the same command again, unchanged, with `error.retryWith`
   (`--approval <id>`). At the operator's terminal (stdin and stdout TTYs, no
   runtime context, no `--json`) the command opens the page and waits up to
   10 minutes itself. If it does not wait, check `RAVI_CONTEXT_KEY` and the
   other runtime markers in the shell.
8a. `CONNECTOR_APPROVAL_DENIED` (exit 3): do not retry; say `error.chatLine`.
    `CONNECTOR_APPROVAL_INVALID` (exit 1): the approval expired, was used, or
    the command changed; run it again without `--approval`.
8b. `CONNECTOR_TOOL_BLOCKED` / `CONNECTOR_DISABLED_BY_ORG` (exit 3) and
    `CONNECTOR_PERMISSION_REQUIRED` (exit 1, read only or a missing scope):
    send `error.chatLine` to the owner privately. The owner changes tool
    rules on the connection's Tools in Console > Connectors; an organization
    owner or admin turns Google back on in /org/connectors.
9. `CONNECTOR_AUTH_REJECTED` after connect: the link was opened by another
   Console user, or the organization does not allow the connector. Start
   again and open the link signed in as the user of `ravi login`.
10. `AUTH_REQUIRED`/`AUTH_EXPIRED` (exit 1): run `ravi login` and retry.
11. A `--project is ignored` line on stderr is expected: connections are not
    project-scoped. Drop the flag before 2027-01-01.
12. If `revoke` executed without `--yes`/`--execute`, the brake regressed:
    check the `contractDryRun` call ordering in
    `src/cli/commands/connectors.ts`.
13. If a brake exits 5 as `SERVER_UNAVAILABLE`, the ContractError rethrow guard
    in `runConnectorCommand` was lost.

## Validation

```bash
bun test src/link/ src/runtime/turn-origin.test.ts src/cloud-auth/connector-auth.test.ts
bun test src/cli/commands/connectors.test.ts src/cli/commands/gmail.test.ts src/cli/commands/mail.test.ts src/cloud-auth/errors.test.ts src/cli/remote-gateway.test.ts
bun test src/cron/ src/cli/commands/cron-commands.test.ts src/router/router.test.ts
```

Live checks against the local CLI (requires `ravi login`; revoke checks are
dry-run only unless you really mean it):

```bash
ravi connectors list --json                          # expect connections (projectId null) + pagination
ravi connectors list --fields id,provider --json     # expect compact items
ravi connectors list --project x --json              # expect the --project line on stderr
ravi connectors revoke conn_x --json                 # expect exit 3 + plan, nothing revoked
ravi connectors connect google --no-open --json      # expect one started document (Console connect URL)
```

From an agent turn in a group chat, `ravi gmail list --json` must exit 3 with
`CONNECTOR_GROUP_BLOCKED`. With "Send email" on Needs approval,
`ravi gmail send ... --execute --json` must exit 3 `CONNECTOR_APPROVAL_REQUIRED`
with `approvalLink` and `retryWith`, and the same command without `--json` in
your terminal must open the approval page and wait. From an agent turn in
the owner's linked DM, the same `gmail send ... --execute --json` goes
through the host gateway and must come back exit 3 with `approvalId`,
`approvalLink`, `expiresAt` and `retryWith`; a 404 / `SERVER_UNAVAILABLE`
there means the daemon runs a bundle where `gmail send` has no gateway route
(rebuild and restart the daemon).
