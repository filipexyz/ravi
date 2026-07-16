# Gmail Ravi App / CHECKS

## Checks

- Manifest validation MUST pass with exactly one `gmail` app and zero errors or warnings.
- Every registered CLI operation MUST start with `ravi gmail` and none MUST contain `sde`.
- Registered operations MUST use `--native --connection default`, and the fallback connector MUST remain available outside the manifest.
- `list` and `read` MUST be read-only; `send` MUST require the `gmail:send` scope; future writes and deletions MUST use the separate `gmail:write` and `gmail:destructive` namespaces.
- `gmail health --json` MUST pass structurally without a Google login (metadata-only).
- The focused client suites MUST pass without network access, covering credential failure before any request, official paths/methods, pagination, fake MIME send, and secret redaction.
- No file under `/home/ravi/sde` MUST be changed by this app.
- No token, refresh token, client secret, or account alias MUST be added.

Run from the repository/worktree root:

```bash
bun run gen:commands
bun test src/apps/gmail src/cli/commands/gmail.test.ts
bun src/cli/index.ts apps check gmail --json
bun src/cli/index.ts gmail --help
bun src/cli/index.ts gmail health --json
bun run sdk:generate
bun run sdk:check
bun run typecheck
bunx biome check src/apps/gmail src/cli/commands/gmail.ts
```

Credential-failure regression with no real backend or network:

```bash
RAVI_STATE_DIR=/tmp/ravi-gmail-empty bun src/cli/index.ts gmail list --json
```
