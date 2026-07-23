# Credentials Runbook

## Before Editing Credentials Code

1. Read the domain spec:

```bash
ravi specs get credentials --mode full --json
```

2. Read the broker spec:

```bash
ravi specs get credentials/broker --mode full --json
```

3. Confirm the change belongs to `ravi credentials`, not:

- `ravi context credentials`
- `ravi runtime credentials`
- provider-specific CLI commands

## Implementation Path

1. Keep the PoC as reference until production parity exists:

```text
pocs/credential-broker
```

2. Create production code under:

```text
src/credentials
src/cli/commands/credentials.ts
```

3. Use Ravi SQLite for metadata and audit.

4. Use backend adapters for secret values.

5. Add `@CommandAccess` metadata to all CLI commands.

6. Add return schemas for JSON output.

7. Run command generation after adding a command file:

```bash
bun run gen:commands
```

## Adding A Provider Connection

Preferred operator flow:

1. Operator pipes a secret through stdin or references an existing backend
   secret ref.
2. CLI writes secret value to backend when `--secret-stdin` is used.
3. CLI stores only metadata and secret ref.
4. CLI output returns redacted metadata only.

Never request a real provider token in chat.

## Leak Response

If a provider token appears in chat, terminal output, logs, traces or markdown:

1. Treat it as exposed.
2. Stop using it.
3. Rotate it at the provider.
4. Remove the leaked material from any local artifact if possible.
5. Add or update a regression check that would have prevented the leak.

## Local Keychain Smoke

Use a generated dummy secret. Do not use a real provider token for smoke tests.

The PoC has a working recipe in `pocs/credential-broker/README.md`.

Expected flow:

1. Generate dummy secret locally.
2. Pipe into `connections add --secret-stdin --backend keychain`.
3. Run `broker exec --action auth.check`.
4. Confirm `secretResolved=true`.
5. Remove with `--delete-secret`.
6. Confirm the Keychain item no longer exists.

## Vault Smoke

Real Vault smoke requires:

```bash
VAULT_ADDR
VAULT_TOKEN
```

Do not print either value.

When a real Vault is unavailable, run KV v2 contract tests instead.

## Do Not Restart Daemon

Credentials development does not require daemon restart unless an explicit
runtime integration has been changed and the operator authorizes restart.
