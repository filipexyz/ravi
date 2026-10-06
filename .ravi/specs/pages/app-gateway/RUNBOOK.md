# Pages app gateway (installation side) / RUNBOOK

## Expose one read-only operation

1. Make sure the operation is safe for viewer-chosen argv. In `ravi.app.json` it needs `"mutating": false` and a `gateway` declaration, for example `"gateway": { "args": { "options": ["--limit"], "positional": 0 } }`. Run `ravi apps check <app-id> --json` and fix every error.
2. Register the target from this installation:
   `ravi pages apps targets set --site demo --aud https://apps.example.ravi.local/slides --app slides --op slides.list --origin https://demo.ravi.page --json`
   The dry-run exits 3 and prints the resolved Console installation. Re-run with `--execute`.
3. As superadmin or the local operator, allow it locally:
   `ravi settings set apps.gateway.allowed_operations slides:slides.list`
   Set `apps.gateway.require_link true` when every viewer must have a Ravi Link contact.
4. Run `ravi login` again if the CLI session predates the `console.apps.relay` scope.
5. Start the daemon with `RAVI_APP_GATEWAY_ENABLED=1` in `~/.ravi/.env`, then `ravi daemon restart`.
6. Confirm in `ravi daemon logs` that `Pages app gateway relay connected` appears.

## Debug

- Runner never connects: check, in order, the env flag, the scope (log line asks for `ravi login`), the allowlist (an unparsable value counts as empty), and the lease (another daemon in the same state directory may hold `console_executor_relay_locks`).
- Parked as `replaced_elsewhere`: another process connected for the same Console installation. Stop the other daemon or machine that uses the same CLI session. A park right after a ticket renewal is a regression of the self-replacement rule.
- Invokes answer `app_gateway_grant_invalid`: the target names another installation or organization. List targets and re-run `set` from the installation that should serve them.
- Invokes answer `app_gateway_permission_denied`: the `<appId>:<operationId>` pair is not in `apps.gateway.allowed_operations`, `require_link` found no single Link contact, or the app's Permission Provider denied the viewer.
- Invokes answer `app_gateway_operation_forbidden`: the operation is not a manifest key, lacks `"mutating": false` or `gateway`, or the Worker grant does not list it.
- Invokes answer `payload_invalid`: the page sent args the `gateway.args` declaration does not accept.
- Logs carry only request ids, app, operation, site, outcome, and duration. Never copy an assertion, grant, or ticket into an issue.

## Stop exposing

- Remove the pair from `apps.gateway.allowed_operations`; the next invoke is refused. An empty allowlist also closes the relay socket on the next lease renewal.
- `ravi pages apps targets remove --site demo --aud <aud> --execute` revokes the target in Console. The aud stays reserved for the gateway on that site.

## Validation

```bash
bun test --timeout 20000 src/app-gateway/ src/apps/gateway-declaration.test.ts src/apps/gateway-command.test.ts src/apps/permissions.test.ts src/mailbox/access.test.ts src/calendar/access.test.ts
bun test src/apps/router.test.ts src/permissions/scope.test.ts src/cli/commands/pages.test.ts src/cli/commands/settings.test.ts src/cli/commands/agents.test.ts
make quality
```
