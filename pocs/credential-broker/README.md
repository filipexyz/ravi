# Ravi Credentials Broker PoC

Isolated proof of concept for the `ravi credentials` domain.

This PoC is intentionally outside `src/cli` so the broker contract can be
worked through without coupling it to `ravi context` or the runtime provider
credential pool.

## Boundaries

- `RAVI_CONTEXT_KEY` identifies and authorizes the caller.
- `ravi credentials` owns provider connections and secret references.
- Metadata lives in `.state/connections.json`.
- Secret values live in macOS Keychain or Vault.
- CLI output must never include secret values.

## Commands

```bash
bun pocs/credential-broker/cli.ts connections list --json

printf '%s' "$SLACK_BOT_TOKEN" \
  | bun pocs/credential-broker/cli.ts connections add \
      --provider slack \
      --connection rbbt \
      --backend keychain \
      --label "RBBT Slack bot" \
      --scope chat:write \
      --scope channels:read \
      --secret-stdin \
      --json

bun pocs/credential-broker/cli.ts policies explain \
  --provider slack \
  --connection rbbt \
  --action messages.send \
  --json

bun pocs/credential-broker/cli.ts broker exec \
  --provider slack \
  --connection rbbt \
  --action messages.send \
  --dry-run \
  --json
```

## Vault Backend

The Vault backend expects KV v2 and these environment variables:

```bash
export VAULT_ADDR=https://vault.example
export VAULT_TOKEN=...
```

Example:

```bash
printf '%s' "$SLACK_BOT_TOKEN" \
  | bun pocs/credential-broker/cli.ts connections add \
      --provider slack \
      --connection rbbt \
      --backend vault \
      --vault-mount secret \
      --vault-path ravi/credentials/slack/rbbt \
      --vault-key token \
      --secret-stdin \
      --json
```

Vault writes are read-merge-write operations against the KV v2 document, so
adding `#token` does not discard other keys already stored at the same path.
`connections remove --delete-secret` removes only the configured key; if it was
the last key, the latest secret version is deleted.

Reads happen only inside `broker exec`. The broker returns whether the secret
was resolved, but never returns the secret value.

## Keychain Note

This PoC uses the macOS `security` CLI. That is good enough to validate the
shape, but production should use a native Security.framework binding so the
secret is not passed through process arguments during writes.
