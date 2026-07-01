# Channels Credentials / RUNBOOK

## Register A Slack Credential Connection

```bash
# Register a new Slack credential connection via the generic credentials CLI
ravi credentials add \
  --provider slack \
  --workspace T0123ACME \
  --app A0456RAVI \
  --label "acme-ravi-bot" \
  --app-token-env SLACK_APP_TOKEN \
  --bot-token-env SLACK_BOT_TOKEN
```

The CLI reads token values from the named env vars, stores them in the backend (Keychain by default), and records only secret refs and metadata in `ravi.db`.

## Verify Connection Status

```bash
ravi credentials list --provider slack --json
ravi credentials status <connection_id> --json
```

Status output includes connection id, workspace, app, scopes, status, last verified timestamp, and redacted aliases. It MUST NOT include raw token values.

## Bind A Channel Instance To A Connection

```bash
# When connecting Slack, bind the channel instance to the credential connection
ravi slack connect --credential <connection_id>
```

This sets `credential_connection_id` on the `ChannelInstance` record.

## Diagnose Connection Failures

If the Slack runner fails to connect:

1. Check connection status: `ravi credentials status <connection_id> --json`
2. If status is `suspended`, `expired`, or `revoked`, the broker refuses secret resolution. Re-register or refresh the connection.
3. Check permissions: `ravi permissions check agent:<id> use credential:slack:<connection_id>`
4. Check action capability: `ravi permissions check agent:<id> execute slack:socket_mode.connect`
5. If both pass, check daemon logs for broker resolution errors (redacted).
6. Check if the Slack app is still installed in the workspace via Slack admin console.

## Rotate Tokens

```bash
# Generate new tokens in the Slack API console
# Then update the connection with new tokens
ravi credentials rotate <connection_id> \
  --app-token-env NEW_SLACK_APP_TOKEN \
  --bot-token-env NEW_SLACK_BOT_TOKEN
```

Rotation reads new values from env, stores them in the backend, and updates secret refs. The old secrets are marked for deletion in the backend. The daemon picks up new refs on the next broker resolution without restart.

## Suspend / Resume A Connection

```bash
ravi credentials disable <connection_id>   # status -> suspended
ravi credentials enable <connection_id>    # status -> active (if not revoked/expired)
```

## Verify Redaction

To confirm no raw tokens appear in output:

```bash
# Check daemon logs
ravi daemon logs | grep -i "xapp-\|xoxb-"
# Expected: no results

# Check events
ravi events stream --filter slack 2>&1 | grep -i "xapp-\|xoxb-"
# Expected: no results

# Check CLI JSON output
ravi credentials status <connection_id> --json | grep -i "xapp-\|xoxb-"
# Expected: no results (only redacted aliases)
```

## Dev-Mode Env Fallback

For local smoke testing without the broker:

```bash
SLACK_APP_TOKEN=xapp-... SLACK_BOT_TOKEN=xoxb-... ravi daemon start
```

The Slack runner will use env vars directly and emit a deprecation warning:

```
[WARN] Slack connection using env var fallback. Register a credential connection for production use.
```

This mode is temporary. Production deployments MUST use the broker.
