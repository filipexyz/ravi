# Credentials Controls / RUNBOOK

## Verify Redaction

```bash
# Check daemon logs for raw secret prefixes
ravi daemon logs | grep -iE "xapp-|xoxb-|xoxp-|xoxa-|sk-|Bearer "
# Expected: no results

# Check events stream
ravi events stream 2>&1 | grep -iE "xapp-|xoxb-|xoxp-|xoxa-"
# Expected: no results

# Check CLI JSON output
ravi credentials list --json | grep -iE "xapp-|xoxb-"
# Expected: no results (only redacted aliases)
```

## Verify Fail-Closed Behavior

```bash
# Disable a connection and attempt resolution
ravi credentials disable <connection_id>
ravi credentials test <connection_id> --json
# Expected: denial error, no secret material
```

## Verify Env Fallback Warnings

```bash
# Start daemon with env vars (dev mode) when a broker connection exists
SLACK_APP_TOKEN=xapp-test SLACK_BOT_TOKEN=xoxb-test ravi daemon start
ravi daemon logs | grep -i "deprecation\|fallback"
# Expected: deprecation warning about env var usage
```

## Audit Inspection

```bash
# Check audit records for credential operations
ravi credentials audit <connection_id> --json
# Verify: no raw secrets in audit records
```
