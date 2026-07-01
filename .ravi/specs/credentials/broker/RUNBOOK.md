# Credentials Broker / RUNBOOK

## Diagnose Broker Resolution Failures

1. Check connection status: `ravi credentials status <connection_id> --json`
2. If status is not `active`, the broker refuses secret resolution.
3. Check caller permissions: `ravi permissions check <caller> use credential:<provider>:<connection_id>`
4. Check action capability: `ravi permissions check <caller> execute <provider>:<action>`
5. If both pass, check daemon logs for broker errors (redacted).

## Verify Backend Availability

```bash
# Keychain (macOS local)
security find-generic-password -s "ravi-credentials" -a "test" 2>&1 | head -1

# Vault (production)
vault status
```

## Verify Composite Secret Atomicity

When resolving a composite secret, confirm both parts are returned or neither:

```bash
ravi credentials test <connection_id> --dry-run --json
```

Dry-run validates connection status and authorization without reading secret material.

## Inspect Connection Lifecycle

```bash
ravi credentials status <connection_id> --json
# Check: status, last_verified_at, created_at, updated_at
```
