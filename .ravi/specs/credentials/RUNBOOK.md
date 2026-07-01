# Credentials / RUNBOOK

## List Credential Connections

```bash
ravi credentials list --json
ravi credentials list --provider slack --json
```

## Check Connection Status

```bash
ravi credentials status <connection_id> --json
```

Output includes connection id, provider, workspace/account, status, last verified timestamp, and redacted aliases. Raw secret values MUST NOT appear.

## Add A Credential Connection

```bash
ravi credentials add --provider <provider> [provider-specific flags]
```

The CLI reads secret values from env vars or interactive prompt, stores them in the backend (Keychain by default), and records only secret refs and metadata in `ravi.db`.

## Rotate Credentials

```bash
ravi credentials rotate <connection_id> [flags]
```

Reads new values, stores in backend, updates secret refs. Old secrets are marked for deletion.

## Disable / Enable

```bash
ravi credentials disable <connection_id>
ravi credentials enable <connection_id>
```

## Verify Redaction

```bash
# Confirm no raw secrets in logs or output
ravi daemon logs | grep -iE "xapp-|xoxb-|xoxp-|sk-"
# Expected: no results
```
