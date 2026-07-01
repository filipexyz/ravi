# Channels / RUNBOOK

## Verify Channel Abstraction

```bash
# Check that Ravi owns operational behavior (routing, presence, notifications)
ravi daemon status
ravi routes list
ravi agents list
```

## Inspect Channel Instances

```bash
ravi instances list --json
ravi instances show <instance_id> --json
```

## Verify Omni Transport

```bash
# Check omni consumer is connected and pulling from JetStream
ravi daemon logs | grep -i "omni\|consumer\|jetstream"
```

## Diagnose Routing Issues

1. Check agent resolution order: account-agent mapping > route match > default agent.
2. Verify routes: `ravi routes list`
3. Check instance target: `ravi instances target <instance> --pattern <pattern>`
